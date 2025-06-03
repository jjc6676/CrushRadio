import { db } from './db'
import { sql } from 'kysely'
import type { YoutubeVideoCache, YoutubeContentPopularity, YoutubeCacheAnalytics } from './schema'

export type CachedVideoData = {
  videoId: string
  title: string
  channelTitle: string
  description: string | null
  duration: string
  publishedAt: Date
  thumbnails: Record<string, any>
  viewCount: bigint | null
  likeCount: bigint | null
  tags: string[] | null
  source: string
}

export type CacheOperation = 'hit' | 'miss' | 'set' | 'invalidate' | 'cleanup'

export type CacheAnalyticsData = {
  endpoint: string
  operation: CacheOperation
  responseTimeMs?: number
  quotaSaved?: number
}

export type PopularityMetrics = {
  videoId: string
  playCount: number
  searchCount: number
  popularityScore: number
  trendingFactor: number
  optimalTtlHours: number
}

/**
 * Get cached videos from database by video IDs
 */
export async function getCachedVideos(videoIds: string[]): Promise<CachedVideoData[]> {
  console.log('Getting cached videos for IDs:', videoIds)
  
  if (videoIds.length === 0) {
    console.log('No video IDs provided, returning empty array')
    return []
  }

  try {
    const startTime = Date.now()
    
    const cachedVideos = await db
      .selectFrom('youtube_video_cache')
      .selectAll()
      .where('video_id', 'in', videoIds)
      .where('expires_at', '>', new Date())
      .execute()

    const responseTime = Date.now() - startTime
    console.log(`Retrieved ${cachedVideos.length} cached videos in ${responseTime}ms`)

    // Update access counts and last accessed timestamps
    if (cachedVideos.length > 0) {
      const foundVideoIds = cachedVideos.map(v => v.video_id)
      await db
        .updateTable('youtube_video_cache')
        .set({
          access_count: sql`COALESCE(access_count, 0) + 1`,
          last_accessed: new Date()
        })
        .where('video_id', 'in', foundVideoIds)
        .execute()

      console.log(`Updated access counts for ${foundVideoIds.length} videos`)
    }

    // Track cache analytics
    await updateCacheAnalytics('search', cachedVideos.length > 0 ? 'hit' : 'miss', responseTime)

    return cachedVideos.map(video => ({
      videoId: video.video_id,
      title: video.title,
      channelTitle: video.channel_title,
      description: video.description,
      duration: video.duration,
      publishedAt: video.published_at,
      thumbnails: video.thumbnails as Record<string, any>,
      viewCount: video.view_count,
      likeCount: video.like_count,
      tags: video.tags as string[] | null,
      source: video.source
    }))
  } catch (error) {
    console.error('Error getting cached videos:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to get cached videos: ${error.message}`)
    }
    throw new Error('Failed to get cached videos: Unknown error')
  }
}

/**
 * Store video data in cache with smart TTL based on popularity
 */
export async function setCachedVideos(videoData: CachedVideoData[]): Promise<void> {
  console.log('Setting cached videos:', videoData.length)
  
  if (videoData.length === 0) {
    console.log('No video data provided, skipping cache set')
    return
  }

  try {
    const startTime = Date.now()

    // Calculate smart TTL for each video based on popularity
    const videoIdsForPopularity = videoData.map(v => v.videoId)
    const popularityData = await db
      .selectFrom('youtube_content_popularity')
      .selectAll()
      .where('video_id', 'in', videoIdsForPopularity)
      .execute()

    const popularityMap = new Map(popularityData.map(p => [p.video_id, p]))

    const cacheEntries = videoData.map(video => {
      const popularity = popularityMap.get(video.videoId)
      const optimalTtlHours = popularity?.optimal_ttl_hours || 24 // Default 24 hours
      const expiresAt = new Date(Date.now() + optimalTtlHours * 60 * 60 * 1000)
      
      console.log(`Setting TTL for ${video.videoId}: ${optimalTtlHours} hours (expires at ${expiresAt})`)

      return {
        video_id: video.videoId,
        title: video.title,
        channel_title: video.channelTitle,
        description: video.description,
        duration: video.duration,
        published_at: video.publishedAt,
        thumbnails: video.thumbnails,
        view_count: video.viewCount,
        like_count: video.likeCount,
        tags: video.tags,
        source: video.source,
        cached_at: new Date(),
        expires_at: expiresAt,
        access_count: 1,
        last_accessed: new Date()
      }
    })

    // Use upsert to handle duplicates
    await db
      .insertInto('youtube_video_cache')
      .values(cacheEntries)
      .onConflict((oc) => oc
        .column('video_id')
        .doUpdateSet((eb) => ({
          title: eb.ref('excluded.title'),
          channel_title: eb.ref('excluded.channel_title'),
          description: eb.ref('excluded.description'),
          duration: eb.ref('excluded.duration'),
          published_at: eb.ref('excluded.published_at'),
          thumbnails: eb.ref('excluded.thumbnails'),
          view_count: eb.ref('excluded.view_count'),
          like_count: eb.ref('excluded.like_count'),
          tags: eb.ref('excluded.tags'),
          source: eb.ref('excluded.source'),
          cached_at: new Date(),
          expires_at: eb.ref('excluded.expires_at'),
          access_count: sql`COALESCE(youtube_video_cache.access_count, 0) + 1`,
          last_accessed: new Date()
        }))
      )
      .execute()

    const responseTime = Date.now() - startTime
    console.log(`Cached ${videoData.length} videos in ${responseTime}ms`)

    // Update popularity tracking
    await updatePopularityTracking(videoData)

    // Track cache analytics
    await updateCacheAnalytics('batch', 'set', responseTime, videoData.length * 50) // Estimate quota saved
  } catch (error) {
    console.error('Error setting cached videos:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to set cached videos: ${error.message}`)
    }
    throw new Error('Failed to set cached videos: Unknown error')
  }
}

/**
 * Update cache analytics with operation metrics
 */
export async function updateCacheAnalytics(
  endpoint: string, 
  operation: CacheOperation,
  responseTimeMs?: number,
  quotaSaved?: number
): Promise<void> {
  console.log(`Updating cache analytics: ${endpoint} - ${operation}`)
  
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Check if entry exists for today
    const existingAnalytics = await db
      .selectFrom('youtube_cache_analytics')
      .selectAll()
      .where('endpoint', '=', endpoint)
      .where('date', '=', today)
      .executeTakeFirst()

    if (existingAnalytics) {
      // Update existing entry
      const updates: Partial<YoutubeCacheAnalytics> = {
        total_requests: (existingAnalytics.total_requests || 0) + 1
      }

      if (operation === 'hit') {
        updates.cache_hits = (existingAnalytics.cache_hits || 0) + 1
      } else if (operation === 'miss') {
        updates.cache_misses = (existingAnalytics.cache_misses || 0) + 1
      }

      if (quotaSaved) {
        updates.quota_saved = (existingAnalytics.quota_saved || 0) + quotaSaved
      }

      if (responseTimeMs) {
        const currentAvg = existingAnalytics.average_response_time_ms || 0
        const totalRequests = existingAnalytics.total_requests || 0
        updates.average_response_time_ms = Math.round(
          (currentAvg * totalRequests + responseTimeMs) / (totalRequests + 1)
        )
      }

      await db
        .updateTable('youtube_cache_analytics')
        .set(updates)
        .where('id', '=', existingAnalytics.id)
        .execute()

      console.log(`Updated existing analytics entry for ${endpoint}`)
    } else {
      // Create new entry
      await db
        .insertInto('youtube_cache_analytics')
        .values({
          endpoint,
          date: today,
          total_requests: 1,
          cache_hits: operation === 'hit' ? 1 : 0,
          cache_misses: operation === 'miss' ? 1 : 0,
          quota_saved: quotaSaved || 0,
          average_response_time_ms: responseTimeMs || 0
        })
        .execute()

      console.log(`Created new analytics entry for ${endpoint}`)
    }
  } catch (error) {
    console.error('Error updating cache analytics:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to update cache analytics: ${error.message}`)
    }
    throw new Error('Failed to update cache analytics: Unknown error')
  }
}

/**
 * Pre-populate cache with popular content
 */
export async function warmCache(): Promise<void> {
  console.log('Starting cache warming process')
  
  try {
    // Get most popular videos that aren't currently cached or are expired
    const popularVideos = await db
      .selectFrom('youtube_content_popularity')
      .selectAll()
      .where('popularity_score', '>', '0.7') // High popularity threshold
      .orderBy('popularity_score', 'desc')
      .limit(50) // Warm top 50 popular videos
      .execute()

    console.log(`Found ${popularVideos.length} popular videos for cache warming`)

    if (popularVideos.length === 0) {
      console.log('No popular videos found for cache warming')
      return
    }

    const videoIds = popularVideos.map(v => v.video_id)
    
    // Check which ones are already cached and not expired
    const alreadyCached = await db
      .selectFrom('youtube_video_cache')
      .select('video_id')
      .where('video_id', 'in', videoIds)
      .where('expires_at', '>', new Date())
      .execute()

    const cachedIds = new Set(alreadyCached.map(c => c.video_id))
    const videosToWarm = popularVideos.filter(v => !cachedIds.has(v.video_id))

    console.log(`${videosToWarm.length} videos need cache warming (${cachedIds.size} already cached)`)

    // Note: In a real implementation, this would fetch video data from YouTube API
    // For now, we'll create placeholder entries that can be updated later
    if (videosToWarm.length > 0) {
      const placeholderEntries = videosToWarm.map(video => ({
        video_id: video.video_id,
        title: `Video ${video.video_id}`, // Placeholder
        channel_title: 'Unknown Channel', // Placeholder
        description: null,
        duration: 'PT0S', // Placeholder
        published_at: new Date(),
        thumbnails: {},
        view_count: null,
        like_count: null,
        tags: null,
        source: 'cache_warming',
        cached_at: new Date(),
        expires_at: new Date(Date.now() + (video.optimal_ttl_hours || 24) * 60 * 60 * 1000),
        access_count: 0,
        last_accessed: new Date()
      }))

      await db
        .insertInto('youtube_video_cache')
        .values(placeholderEntries)
        .onConflict((oc) => oc.column('video_id').doNothing())
        .execute()

      console.log(`Warmed cache with ${videosToWarm.length} placeholder entries`)
    }

    await updateCacheAnalytics('warming', 'set', undefined, videosToWarm.length * 100)
  } catch (error) {
    console.error('Error warming cache:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to warm cache: ${error.message}`)
    }
    throw new Error('Failed to warm cache: Unknown error')
  }
}

/**
 * Remove expired cache entries
 */
export async function cleanupExpiredCache(): Promise<void> {
  console.log('Starting expired cache cleanup')
  
  try {
    const startTime = Date.now()
    
    // Find expired entries
    const expiredEntries = await db
      .selectFrom('youtube_video_cache')
      .select('video_id')
      .where('expires_at', '<=', new Date())
      .execute()

    console.log(`Found ${expiredEntries.length} expired cache entries`)

    if (expiredEntries.length === 0) {
      console.log('No expired entries to clean up')
      return
    }

    // Delete expired entries
    const deleteResult = await db
      .deleteFrom('youtube_video_cache')
      .where('expires_at', '<=', new Date())
      .execute()

    const responseTime = Date.now() - startTime
    console.log(`Cleaned up ${deleteResult.length} expired entries in ${responseTime}ms`)

    await updateCacheAnalytics('cleanup', 'cleanup', responseTime)
  } catch (error) {
    console.error('Error cleaning up expired cache:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to cleanup expired cache: ${error.message}`)
    }
    throw new Error('Failed to cleanup expired cache: Unknown error')
  }
}

/**
 * Update popularity tracking for videos
 */
async function updatePopularityTracking(videoData: CachedVideoData[]): Promise<void> {
  console.log('Updating popularity tracking for', videoData.length, 'videos')
  
  try {
    const popularityUpdates = videoData.map(video => {
      // Calculate basic popularity metrics
      const viewCount = Number(video.viewCount || 0)
      const likeCount = Number(video.likeCount || 0)
      const ageInDays = Math.max(1, (Date.now() - video.publishedAt.getTime()) / (1000 * 60 * 60 * 24))
      
      // Simple popularity scoring algorithm
      const viewScore = Math.log10(Math.max(1, viewCount)) / 10
      const likeScore = Math.log10(Math.max(1, likeCount)) / 8
      const freshnessScore = Math.max(0.1, 1 / Math.log10(ageInDays + 1))
      const popularityScore = (viewScore + likeScore + freshnessScore) / 3
      
      // Calculate trending factor (higher for recent popular content)
      const trendingFactor = popularityScore * freshnessScore
      
      // Calculate optimal TTL (more popular = longer cache)
      const baseTtl = 24 // 24 hours base
      const popularityMultiplier = 1 + popularityScore * 2 // 1x to 3x multiplier
      const optimalTtlHours = Math.min(168, Math.max(6, baseTtl * popularityMultiplier)) // 6 hours to 1 week
      
      console.log(`Video ${video.videoId}: popularity=${popularityScore.toFixed(3)}, TTL=${optimalTtlHours.toFixed(1)}h`)

      return {
        video_id: video.videoId,
        play_count: 1,
        search_count: 1,
        popularity_score: popularityScore.toString(),
        trending_factor: trendingFactor.toString(),
        optimal_ttl_hours: Math.round(optimalTtlHours),
        last_played: new Date()
      }
    })

    // Upsert popularity data
    await db
      .insertInto('youtube_content_popularity')
      .values(popularityUpdates)
      .onConflict((oc) => oc
        .column('video_id')
        .doUpdateSet((eb) => ({
          play_count: sql`COALESCE(youtube_content_popularity.play_count, 0) + ${eb.ref('excluded.play_count')}`,
          search_count: sql`COALESCE(youtube_content_popularity.search_count, 0) + ${eb.ref('excluded.search_count')}`,
          popularity_score: eb.ref('excluded.popularity_score'),
          trending_factor: eb.ref('excluded.trending_factor'),
          optimal_ttl_hours: eb.ref('excluded.optimal_ttl_hours'),
          last_played: eb.ref('excluded.last_played')
        }))
      )
      .execute()

    console.log(`Updated popularity tracking for ${videoData.length} videos`)
  } catch (error) {
    console.error('Error updating popularity tracking:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to update popularity tracking: ${error.message}`)
    }
    throw new Error('Failed to update popularity tracking: Unknown error')
  }
}

/**
 * Get cache statistics for monitoring
 */
export async function getCacheStatistics(): Promise<{
  totalCachedVideos: number
  expiredVideos: number
  hitRate: number
  averageResponseTime: number
  quotaSavedToday: number
}> {
  console.log('Getting cache statistics')
  
  try {
    // Get total cached videos
    const totalCached = await db
      .selectFrom('youtube_video_cache')
      .select(db.fn.count<number>('video_id').as('count'))
      .where('expires_at', '>', new Date())
      .executeTakeFirst()

    // Get expired videos
    const expired = await db
      .selectFrom('youtube_video_cache')
      .select(db.fn.count<number>('video_id').as('count'))
      .where('expires_at', '<=', new Date())
      .executeTakeFirst()

    // Get today's analytics
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    const todayAnalytics = await db
      .selectFrom('youtube_cache_analytics')
      .select([
        db.fn.sum<number>('cache_hits').as('total_hits'),
        db.fn.sum<number>('cache_misses').as('total_misses'),
        db.fn.avg<number>('average_response_time_ms').as('avg_response_time'),
        db.fn.sum<number>('quota_saved').as('quota_saved')
      ])
      .where('date', '=', today)
      .executeTakeFirst()

    const totalHits = todayAnalytics?.total_hits || 0
    const totalMisses = todayAnalytics?.total_misses || 0
    const hitRate = totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0

    const stats = {
      totalCachedVideos: totalCached?.count || 0,
      expiredVideos: expired?.count || 0,
      hitRate: hitRate * 100, // Convert to percentage
      averageResponseTime: todayAnalytics?.avg_response_time || 0,
      quotaSavedToday: todayAnalytics?.quota_saved || 0
    }

    console.log('Cache statistics:', stats)
    return stats
  } catch (error) {
    console.error('Error getting cache statistics:', error)
    if (error instanceof Error) {
      throw new Error(`Failed to get cache statistics: ${error.message}`)
    }
    throw new Error('Failed to get cache statistics: Unknown error')
  }
}