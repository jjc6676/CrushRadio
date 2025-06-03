import { schema } from "./batch_POST.schema";
import { db } from "../../helpers/db";
import { getCachedVideos, setCachedVideos, updateCacheAnalytics, warmCache, cleanupExpiredCache, type CachedVideoData } from "../../helpers/youTubeVideoCache";

interface YouTubeVideosResponse {
  items: Array<{
    id: string;
    snippet: {
      title: string;
      channelTitle: string;
      description: string;
      thumbnails: {
        default: { url: string };
        medium: { url: string };
        high: { url: string };
        maxres?: { url: string };
      };
      publishedAt: string;
      categoryId: string;
      tags?: string[];
    };
    contentDetails: {
      duration: string;
      definition: string;
      caption: string;
    };
    statistics: {
      viewCount: string;
      likeCount?: string;
      commentCount?: string;
    };
  }>;
}

interface QuotaUsage {
  used: number;
  limit: number;
  resetTime: number;
}

const QUOTA_COST_PER_BATCH = 1; // videos.list costs 1 unit per request
const QUOTA_WARNING_THRESHOLD = 0.8;
const QUOTA_CRITICAL_THRESHOLD = 0.95;
const MAX_VIDEOS_PER_REQUEST = 50; // YouTube API limit

// Static fallback database for emergency cases
const STATIC_VIDEO_DATABASE: Record<string, CachedVideoData> = {
  "dQw4w9WgXcQ": {
    videoId: "dQw4w9WgXcQ",
    title: "Rick Astley - Never Gonna Give You Up",
    channelTitle: "Rick Astley",
    description: "The official video for Rick Astley's 'Never Gonna Give You Up'",
    duration: "PT3M33S",
    thumbnails: {
      default: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg" },
      medium: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" },
      high: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
      maxres: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg" }
    },
    publishedAt: new Date("2009-10-25T06:57:33Z"),
    viewCount: BigInt("1000000000"),
    likeCount: BigInt("10000000"),
    tags: ["pop", "80s", "classic"],
    source: "static_db"
  },
  "9bZkp7q19f0": {
    videoId: "9bZkp7q19f0",
    title: "PSY - GANGNAM STYLE",
    channelTitle: "officialpsy",
    description: "PSY - GANGNAM STYLE (강남스타일) M/V",
    duration: "PT4M12S",
    thumbnails: {
      default: { url: "https://i.ytimg.com/vi/9bZkp7q19f0/default.jpg" },
      medium: { url: "https://i.ytimg.com/vi/9bZkp7q19f0/mqdefault.jpg" },
      high: { url: "https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg" },
      maxres: { url: "https://i.ytimg.com/vi/9bZkp7q19f0/maxresdefault.jpg" }
    },
    publishedAt: new Date("2012-07-15T08:34:21Z"),
    viewCount: BigInt("4000000000"),
    likeCount: BigInt("20000000"),
    tags: ["k-pop", "dance", "korean"],
    source: "static_db"
  }
};

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getOrCreateTodaysQuota(): Promise<QuotaUsage> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Try to get today's quota record
  let quotaRecord = await db
    .selectFrom('youtube_quota_tracking')
    .selectAll()
    .where('date', '>=', today)
    .where('date', '<', new Date(today.getTime() + 24 * 60 * 60 * 1000))
    .executeTakeFirst();

  if (!quotaRecord) {
    // Create new record for today
    const resetTime = new Date();
    resetTime.setHours(24, 0, 0, 0); // Reset at midnight tomorrow
    
    quotaRecord = await db
      .insertInto('youtube_quota_tracking')
      .values({
        date: today,
        quota_used: 0,
        quota_limit: 10000,
        reset_time: resetTime,
        last_updated: new Date()
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  return {
    used: quotaRecord.quota_used,
    limit: quotaRecord.quota_limit,
    resetTime: quotaRecord.reset_time.getTime()
  };
}

async function updateQuotaUsage(newUsage: number): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  await db
    .updateTable('youtube_quota_tracking')
    .set({
      quota_used: newUsage,
      last_updated: new Date()
    })
    .where('date', '>=', today)
    .where('date', '<', new Date(today.getTime() + 24 * 60 * 60 * 1000))
    .execute();
}

async function logQuotaEvent(eventType: string, quotaUsed: number, quotaLimit: number, endpoint: string, message: string, fallbackType?: string): Promise<void> {
  await db
    .insertInto('youtube_quota_events')
    .values({
      timestamp: new Date(),
      event_type: eventType,
      quota_used: quotaUsed,
      quota_limit: quotaLimit,
      endpoint,
      fallback_type: fallbackType || null,
      message
    })
    .execute();
  
  console.log(`Quota event logged: ${eventType} - ${message}`);
}

async function checkQuotaStatus(): Promise<{ canUseAPI: boolean; warningLevel: string; quotaUsage: QuotaUsage }> {
  const quotaUsage = await getOrCreateTodaysQuota();
  const now = Date.now();
  
  // Check if quota needs to be reset
  if (now > quotaUsage.resetTime) {
    console.log("Resetting daily quota usage");
    const oldUsed = quotaUsage.used;
    
    // Create new record for today with reset quota
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const resetTime = new Date();
    resetTime.setHours(24, 0, 0, 0);
    
    await db
      .insertInto('youtube_quota_tracking')
      .values({
        date: today,
        quota_used: 0,
        quota_limit: quotaUsage.limit,
        reset_time: resetTime,
        last_updated: new Date()
      })
      .execute();
    
    // Log quota reset event
    await logQuotaEvent(
      'quota_reset',
      0,
      quotaUsage.limit,
      'system',
      `Daily quota reset. Previous usage: ${oldUsed}/${quotaUsage.limit}`
    );
    
    // Update local quotaUsage object
    quotaUsage.used = 0;
    quotaUsage.resetTime = resetTime.getTime();
  }

  const usageRatio = quotaUsage.used / quotaUsage.limit;
  
  if (usageRatio >= QUOTA_CRITICAL_THRESHOLD) {
    return { canUseAPI: false, warningLevel: "critical", quotaUsage };
  } else if (usageRatio >= QUOTA_WARNING_THRESHOLD) {
    return { canUseAPI: true, warningLevel: "warning", quotaUsage };
  } else {
    return { canUseAPI: true, warningLevel: "normal", quotaUsage };
  }
}

async function getStaticVideoData(videoIds: string[], quotaUsage: QuotaUsage, fallbackType: string): Promise<CachedVideoData[]> {
  console.log(`Fetching static data for ${videoIds.length} video IDs`);
  
  // Log fallback usage
  await logQuotaEvent(
    'fallback_triggered',
    quotaUsage.used,
    quotaUsage.limit,
    'youtube/batch',
    `Static data fallback used for ${videoIds.length} video IDs`,
    fallbackType
  );
  
  const results: CachedVideoData[] = [];
  
  for (const videoId of videoIds) {
    const staticData = STATIC_VIDEO_DATABASE[videoId];
    
    if (staticData) {
      console.log(`Static data found for video ${videoId}`);
      results.push(staticData);
    } else {
      console.log(`No static data for video ${videoId}, generating placeholder`);
      // Generate placeholder data for unknown videos
      results.push({
        videoId,
        title: `Music Video ${videoId}`,
        channelTitle: "Unknown Artist",
        description: "Music video details unavailable",
        duration: "PT3M30S",
        thumbnails: {
          default: { url: `https://i.ytimg.com/vi/${videoId}/default.jpg` },
          medium: { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` },
          high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
        },
        publishedAt: new Date(),
        viewCount: BigInt("0"),
        likeCount: null,
        tags: ["music"],
        source: "placeholder"
      });
    }
  }
  
  return results;
}

async function fetchYouTubeVideoDetails(videoIds: string[], retries = 3): Promise<CachedVideoData[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY environment variable is not set");
  }

  const results: CachedVideoData[] = [];
  
  // Process videos in chunks of 50 (YouTube API limit)
  for (let i = 0; i < videoIds.length; i += MAX_VIDEOS_PER_REQUEST) {
    const chunk = videoIds.slice(i, i + MAX_VIDEOS_PER_REQUEST);
    console.log(`Processing chunk ${Math.floor(i / MAX_VIDEOS_PER_REQUEST) + 1}: ${chunk.length} videos`);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`YouTube API videos.list attempt ${attempt}/${retries} for ${chunk.length} videos`);
        
        const url = new URL("https://www.googleapis.com/youtube/v3/videos");
        url.searchParams.set("part", "snippet,contentDetails,statistics");
        url.searchParams.set("id", chunk.join(","));
        url.searchParams.set("key", apiKey);

        const response = await fetch(url.toString());
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`YouTube API error (attempt ${attempt}): ${response.status} - ${errorText}`);
          
          if (response.status === 403) {
            throw new Error("YouTube API quota exceeded or invalid API key");
          }
          
          if (response.status === 429) {
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`Rate limited, waiting ${waitTime}ms before retry`);
            await sleep(waitTime);
            continue;
          }
          
          throw new Error(`YouTube API error: ${response.status}`);
        }

        const data: YouTubeVideosResponse = await response.json();
        console.log(`YouTube API videos.list successful, received ${data.items?.length || 0} videos`);
        
        // Update quota usage in database
        const currentQuota = await getOrCreateTodaysQuota();
        const newUsage = currentQuota.used + QUOTA_COST_PER_BATCH;
        await updateQuotaUsage(newUsage);
        
        // Log API call event
        await logQuotaEvent(
          'api_call',
          newUsage,
          currentQuota.limit,
          'youtube/batch',
          `Batch API call completed for ${chunk.length} videos. Cost: ${QUOTA_COST_PER_BATCH} units. New usage: ${newUsage}/${currentQuota.limit}`
        );
        
        console.log(`Quota usage: ${newUsage}/${currentQuota.limit} (${((newUsage / currentQuota.limit) * 100).toFixed(1)}%)`);
        
        // Process and transform the results
        const chunkResults = data.items.map(item => {
          const videoData: CachedVideoData = {
            videoId: item.id,
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            description: item.snippet.description,
            duration: item.contentDetails.duration,
            thumbnails: item.snippet.thumbnails,
            publishedAt: new Date(item.snippet.publishedAt),
            viewCount: BigInt(item.statistics.viewCount),
            likeCount: item.statistics.likeCount ? BigInt(item.statistics.likeCount) : null,
            tags: item.snippet.tags,
            source: "youtube_api"
          };
          
          console.log(`Prepared video data for ${item.id}: "${item.snippet.title}"`);
          return videoData;
        });
        
        results.push(...chunkResults);
        break; // Success, move to next chunk
        
      } catch (error) {
        console.error(`YouTube API attempt ${attempt} failed for chunk:`, error);
        
        if (attempt === retries) {
          throw error;
        }
        
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Waiting ${waitTime}ms before retry`);
        await sleep(waitTime);
      }
    }
  }
  
  return results;
}

export async function handle(request: Request) {
  const startTime = Date.now();
  
  try {
    console.log("YouTube batch endpoint called");
    
    const json = await request.json();
    const { videoIds } = schema.parse(json);
    
    console.log(`Batch request for ${videoIds.length} video IDs: ${videoIds.join(", ")}`);
    
    // Perform cache cleanup and warming in background (don't await)
    cleanupExpiredCache().catch(console.error);
    warmCache().catch(console.error);
    
    // Get quota status first for the empty request case
    const initialQuotaStatus = await checkQuotaStatus();
    
    if (videoIds.length === 0) {
      return Response.json({
        videos: [],
        metadata: {
          totalRequested: 0,
          totalReturned: 0,
          cacheHits: 0,
          apiCalls: 0,
          fallbackUsed: null,
          quotaStatus: {
            used: initialQuotaStatus.quotaUsage.used,
            limit: initialQuotaStatus.quotaUsage.limit,
            percentage: Math.round((initialQuotaStatus.quotaUsage.used / initialQuotaStatus.quotaUsage.limit) * 100),
            warningLevel: initialQuotaStatus.warningLevel
          },
          timestamp: new Date().toISOString()
        }
      });
    }
    
    const quotaStatus = await checkQuotaStatus();
    const { canUseAPI, warningLevel, quotaUsage } = quotaStatus;
    console.log(`Quota status: ${warningLevel}, Can use API: ${canUseAPI}`);
    
    let allVideos: CachedVideoData[] = [];
    let fallbackUsed: string | null = null;
    let apiCalls = 0;
    
    // Step 1: Check cache using helper
    const cachedVideos = await getCachedVideos(videoIds);
    const cachedVideoIds = new Set(cachedVideos.map(v => v.videoId));
    const missing = videoIds.filter(id => !cachedVideoIds.has(id));
    
    allVideos.push(...cachedVideos);
    console.log(`Cache results: ${cachedVideos.length} cached, ${missing.length} missing`);
    
    // Step 2: Try to fetch missing videos from YouTube API
    if (missing.length > 0) {
      try {
        if (!canUseAPI) {
          console.log("Quota critical - skipping YouTube API for missing videos");
          const staticVideos = await getStaticVideoData(missing, quotaUsage, "static_database");
          await setCachedVideos(staticVideos);
          allVideos.push(...staticVideos);
          fallbackUsed = "static_database";
        } else {
          console.log(`Fetching ${missing.length} missing videos from YouTube API`);
          const apiVideos = await fetchYouTubeVideoDetails(missing);
          
          // Cache the API results using helper
          if (apiVideos.length > 0) {
            await setCachedVideos(apiVideos);
          }
          
          allVideos.push(...apiVideos);
          apiCalls = Math.ceil(missing.length / MAX_VIDEOS_PER_REQUEST);
          
          // If we didn't get all requested videos, fill with static data
          const receivedIds = new Set(apiVideos.map(v => v.videoId));
          const stillMissing = missing.filter(id => !receivedIds.has(id));
          
          if (stillMissing.length > 0) {
            console.log(`${stillMissing.length} videos still missing after API call, using static data`);
            const staticVideos = await getStaticVideoData(stillMissing, quotaUsage, "partial_static");
            await setCachedVideos(staticVideos);
            allVideos.push(...staticVideos);
            fallbackUsed = fallbackUsed || "partial_static";
          }
        }
      } catch (error) {
        console.error("YouTube API failed for missing videos, using static database:", error);
        
        try {
          const staticVideos = await getStaticVideoData(missing, quotaUsage, "static_database");
          await setCachedVideos(staticVideos);
          allVideos.push(...staticVideos);
          fallbackUsed = "static_database";
        } catch (staticError) {
          console.error("Static database failed, using placeholder data:", staticError);
          const placeholderVideos = await getStaticVideoData(missing, quotaUsage, "placeholder");
          await setCachedVideos(placeholderVideos);
          allVideos.push(...placeholderVideos);
          fallbackUsed = "placeholder";
        }
      }
    }
    
    // Sort results to match the original order of requested video IDs
    const videoMap = new Map(allVideos.map(video => [video.videoId, video]));
    const orderedVideos = videoIds.map(id => videoMap.get(id)).filter(Boolean) as CachedVideoData[];
    
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    // Record analytics using helper
    const quotaSaved = cachedVideos.length > 0 ? Math.ceil(cachedVideos.length / MAX_VIDEOS_PER_REQUEST) : 0;
    await updateCacheAnalytics('youtube/batch', cachedVideos.length > 0 ? 'hit' : 'miss', responseTime, quotaSaved);
    
    console.log(`Batch request completed. Requested: ${videoIds.length}, Returned: ${orderedVideos.length}, Cache hits: ${cachedVideos.length}, API calls: ${apiCalls}, Fallback: ${fallbackUsed || 'none'}, Response time: ${responseTime}ms`);
    
    // Transform data for response
    const transformedVideos = orderedVideos.map(video => ({
      videoId: video.videoId,
      title: video.title,
      channelTitle: video.channelTitle,
      description: video.description || '',
      duration: video.duration,
      thumbnails: video.thumbnails,
      publishedAt: video.publishedAt.toISOString(),
      viewCount: video.viewCount?.toString() || '0',
      likeCount: video.likeCount?.toString(),
      tags: video.tags || [],
      cachedAt: new Date().toISOString(), // Use current time for response
      source: video.source
    }));
    
    const response = {
      videos: transformedVideos,
      metadata: {
        totalRequested: videoIds.length,
        totalReturned: orderedVideos.length,
        cacheHits: cachedVideos.length,
        apiCalls,
        fallbackUsed,
        quotaStatus: {
          used: quotaStatus.quotaUsage.used,
          limit: quotaStatus.quotaUsage.limit,
          percentage: Math.round((quotaStatus.quotaUsage.used / quotaStatus.quotaUsage.limit) * 100),
          warningLevel: warningLevel
        },
        timestamp: new Date().toISOString()
      }
    };
    
    // Set cache headers for client-side caching
    const cacheHeaders = {
      "Cache-Control": "public, max-age=3600", // 1 hour
      "ETag": `"batch-${Date.now()}"`,
      "Vary": "Accept-Encoding"
    };
    
    return Response.json(response, { 
      status: 200,
      headers: cacheHeaders
    });
    
  } catch (error) {
    console.error("YouTube batch endpoint error:", error);
    
    if (error instanceof Error) {
      return Response.json(
        { 
          error: "Batch request failed", 
          message: error.message,
          timestamp: new Date().toISOString()
        }, 
        { status: 400 }
      );
    }
    
    return Response.json(
      { 
        error: "Internal server error", 
        message: "An unexpected error occurred",
        timestamp: new Date().toISOString()
      }, 
      { status: 500 }
    );
  }
}