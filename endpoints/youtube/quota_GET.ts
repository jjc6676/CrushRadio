import { schema } from "./quota_GET.schema";
import { db } from "../../helpers/db";

interface QuotaUsage {
  used: number;
  limit: number;
  resetTime: number;
}

interface QuotaEvent {
  timestamp: string;
  eventType: 'api_call' | 'quota_warning' | 'quota_critical' | 'fallback_triggered' | 'quota_reset';
  quotaUsed: number;
  quotaLimit: number;
  endpoint?: string;
  fallbackType?: string;
  message: string;
}

const QUOTA_WARNING_THRESHOLD = 0.8;
const QUOTA_CRITICAL_THRESHOLD = 0.95;
const QUOTA_COSTS = {
  search: 100,
  videos: 1,
  playlists: 1,
  channels: 1
};

const RATE_LIMIT_WINDOWS = {
  search: { requests: 10, windowMs: 60 * 1000 }, // 10 requests per minute
  batch: { requests: 5, windowMs: 60 * 1000 }    // 5 requests per minute
};

// Rate limiting tracking (keeping this in memory as it's short-term)
const rateLimitTracking = new Map<string, Array<{ timestamp: number; endpoint: string }>>();

// Pacific Time timezone helper functions
function getPacificTime(date: Date = new Date()): Date {
  // Convert to Pacific Time using Intl API which handles PST/PDT automatically
  const pacificTime = new Date(date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return pacificTime;
}

function getPacificMidnight(date: Date = new Date()): Date {
  const pacificTime = getPacificTime(date);
  pacificTime.setHours(0, 0, 0, 0);
  return pacificTime;
}

function getNextPacificMidnight(date: Date = new Date()): Date {
  const pacificTime = getPacificTime(date);
  pacificTime.setHours(24, 0, 0, 0); // Next midnight
  return pacificTime;
}

function convertToPacificDate(utcDate: Date): Date {
  // Convert UTC date to equivalent Pacific Time date
  return new Date(utcDate.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
}

async function getOrCreateTodaysQuota(): Promise<QuotaUsage> {
  const todayPacific = getPacificMidnight();
  const tomorrowPacific = getNextPacificMidnight();
  
  try {
    // First, try to get existing record
    let quotaRecord = await db
      .selectFrom('youtube_quota_tracking')
      .selectAll()
      .where('date', '>=', todayPacific)
      .where('date', '<', tomorrowPacific)
      .executeTakeFirst();

    if (quotaRecord) {
      return {
        used: quotaRecord.quota_used,
        limit: quotaRecord.quota_limit,
        resetTime: quotaRecord.reset_time.getTime()
      };
    }

    // If no record exists, use upsert to handle race conditions
    const resetTime = getNextPacificMidnight();
    
    quotaRecord = await db
      .insertInto('youtube_quota_tracking')
      .values({
        date: todayPacific,
        quota_used: 3201, // Initialize with current Google Console usage
        quota_limit: 10000,
        reset_time: resetTime,
        last_updated: new Date()
      })
      .onConflict((oc) => oc
        .column('date')
        .doUpdateSet({
          last_updated: new Date()
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    
    // Only log initialization event if this was a new insert (not an update)
    if (quotaRecord.quota_used === 3201) {
      await addQuotaEvent({
        timestamp: new Date().toISOString(),
        eventType: 'quota_reset',
        quotaUsed: 3201,
        quotaLimit: 10000,
        message: `Quota tracking initialized with current Google Console usage: 3,201/10,000 (Pacific Time: ${todayPacific.toISOString()})`
      });
    }

    return {
      used: quotaRecord.quota_used,
      limit: quotaRecord.quota_limit,
      resetTime: quotaRecord.reset_time.getTime()
    };
    
  } catch (error) {
    console.error("Error in getOrCreateTodaysQuota:", error);
    
    // If we hit a constraint error, try to fetch the existing record one more time
    if (error instanceof Error && error.message.includes('duplicate key')) {
      console.log("Handling duplicate key by fetching existing record");
      
      const existingRecord = await db
        .selectFrom('youtube_quota_tracking')
        .selectAll()
        .where('date', '>=', todayPacific)
        .where('date', '<', tomorrowPacific)
        .executeTakeFirst();
      
      if (existingRecord) {
        return {
          used: existingRecord.quota_used,
          limit: existingRecord.quota_limit,
          resetTime: existingRecord.reset_time.getTime()
        };
      }
    }
    
    throw new Error(`Failed to get or create today's quota: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function updateQuotaUsage(newUsage: number): Promise<void> {
  const todayPacific = getPacificMidnight();
  const tomorrowPacific = getNextPacificMidnight();
  
  await db
    .updateTable('youtube_quota_tracking')
    .set({
      quota_used: newUsage,
      last_updated: new Date()
    })
    .where('date', '>=', todayPacific)
    .where('date', '<', tomorrowPacific)
    .execute();
}

async function performQuotaReset(quotaUsage: QuotaUsage): Promise<QuotaUsage> {
  const todayPacific = getPacificMidnight();
  const resetTime = getNextPacificMidnight();
  const oldUsed = quotaUsage.used;
  
  try {
    console.log("Performing quota reset for Pacific Time");
    
    // Use upsert to handle potential race conditions during reset
    const quotaRecord = await db
      .insertInto('youtube_quota_tracking')
      .values({
        date: todayPacific,
        quota_used: 0,
        quota_limit: quotaUsage.limit,
        reset_time: resetTime,
        last_updated: new Date()
      })
      .onConflict((oc) => oc
        .column('date')
        .doUpdateSet({
          quota_used: 0,
          quota_limit: quotaUsage.limit,
          reset_time: resetTime,
          last_updated: new Date()
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    
    // Log quota reset event
    await addQuotaEvent({
      timestamp: new Date().toISOString(),
      eventType: 'quota_reset',
      quotaUsed: 0,
      quotaLimit: quotaUsage.limit,
      message: `Daily quota reset at Pacific Time midnight. Previous usage: ${oldUsed}/${quotaUsage.limit}. New reset time: ${resetTime.toISOString()}`
    });
    
    return {
      used: 0,
      limit: quotaUsage.limit,
      resetTime: resetTime.getTime()
    };
    
  } catch (error) {
    console.error("Error during quota reset:", error);
    
    // If reset fails due to constraint issues, try to get the existing reset record
    if (error instanceof Error && error.message.includes('duplicate key')) {
      console.log("Handling duplicate key during reset by fetching existing reset record");
      
      const tomorrowPacific = getNextPacificMidnight();
      const existingRecord = await db
        .selectFrom('youtube_quota_tracking')
        .selectAll()
        .where('date', '>=', todayPacific)
        .where('date', '<', tomorrowPacific)
        .executeTakeFirst();
      
      if (existingRecord) {
        // If the existing record is already reset (quota_used = 0), use it
        if (existingRecord.quota_used === 0) {
          console.log("Found existing reset record, using it");
          return {
            used: 0,
            limit: existingRecord.quota_limit,
            resetTime: existingRecord.reset_time.getTime()
          };
        }
        
        // If existing record isn't reset yet, force update it
        console.log("Found existing non-reset record, updating it");
        await db
          .updateTable('youtube_quota_tracking')
          .set({
            quota_used: 0,
            reset_time: resetTime,
            last_updated: new Date()
          })
          .where('date', '>=', todayPacific)
          .where('date', '<', tomorrowPacific)
          .execute();
        
        return {
          used: 0,
          limit: existingRecord.quota_limit,
          resetTime: resetTime.getTime()
        };
      }
    }
    
    throw new Error(`Quota reset failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function checkQuotaStatus(): Promise<{ 
  canUseAPI: boolean; 
  warningLevel: 'normal' | 'warning' | 'critical'; 
  fallbackMode: boolean;
  resetTimeRemaining: number;
  quotaUsage: QuotaUsage;
}> {
  const now = Date.now();
  const nowPacific = getPacificTime();
  let quotaUsage = await getOrCreateTodaysQuota();
  
  // Check if quota needs to be reset (based on Pacific Time)
  if (now > quotaUsage.resetTime) {
    console.log("Quota reset needed - performing reset");
    quotaUsage = await performQuotaReset(quotaUsage);
  }

  const usageRatio = quotaUsage.used / quotaUsage.limit;
  const resetTimeRemaining = quotaUsage.resetTime - now;
  
  if (usageRatio >= QUOTA_CRITICAL_THRESHOLD) {
    return { 
      canUseAPI: false, 
      warningLevel: 'critical', 
      fallbackMode: true,
      resetTimeRemaining,
      quotaUsage
    };
  } else if (usageRatio >= QUOTA_WARNING_THRESHOLD) {
    return { 
      canUseAPI: true, 
      warningLevel: 'warning', 
      fallbackMode: false,
      resetTimeRemaining,
      quotaUsage
    };
  } else {
    return { 
      canUseAPI: true, 
      warningLevel: 'normal', 
      fallbackMode: false,
      resetTimeRemaining,
      quotaUsage
    };
  }
}

async function addQuotaEvent(event: QuotaEvent): Promise<void> {
  try {
    await db
      .insertInto('youtube_quota_events')
      .values({
        timestamp: new Date(event.timestamp),
        event_type: event.eventType,
        quota_used: event.quotaUsed,
        quota_limit: event.quotaLimit,
        endpoint: event.endpoint || null,
        fallback_type: event.fallbackType || null,
        message: event.message
      })
      .execute();
    
    console.log(`Quota event logged: ${event.eventType} - ${event.message}`);
  } catch (error) {
    console.error("Failed to log quota event:", error);
    // Don't throw - logging failures shouldn't break the main functionality
  }
}

async function getRecentQuotaEvents(limit: number): Promise<QuotaEvent[]> {
  const events = await db
    .selectFrom('youtube_quota_events')
    .selectAll()
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .execute();
  
  return events.map(event => ({
    timestamp: event.timestamp.toISOString(),
    eventType: event.event_type as QuotaEvent['eventType'],
    quotaUsed: event.quota_used,
    quotaLimit: event.quota_limit,
    endpoint: event.endpoint || undefined,
    fallbackType: event.fallback_type || undefined,
    message: event.message
  }));
}

async function getTotalEventsCount(): Promise<number> {
  const result = await db
    .selectFrom('youtube_quota_events')
    .select(db.fn.count('id').as('count'))
    .executeTakeFirstOrThrow();
  
  return Number(result.count);
}

function checkRateLimits(): {
  search: { withinLimit: boolean; requestsInWindow: number; windowResetMs: number };
  batch: { withinLimit: boolean; requestsInWindow: number; windowResetMs: number };
} {
  const now = Date.now();
  const results = {
    search: { withinLimit: true, requestsInWindow: 0, windowResetMs: 0 },
    batch: { withinLimit: true, requestsInWindow: 0, windowResetMs: 0 }
  };

  for (const [endpoint, config] of Object.entries(RATE_LIMIT_WINDOWS)) {
    const requests = rateLimitTracking.get(endpoint) || [];
    
    // Remove old requests outside the window
    const windowStart = now - config.windowMs;
    const recentRequests = requests.filter(req => req.timestamp > windowStart);
    rateLimitTracking.set(endpoint, recentRequests);
    
    const withinLimit = recentRequests.length < config.requests;
    const oldestRequest = recentRequests[0];
    const windowResetMs = oldestRequest ? (oldestRequest.timestamp + config.windowMs) - now : 0;
    
    if (endpoint === 'search') {
      results.search = {
        withinLimit,
        requestsInWindow: recentRequests.length,
        windowResetMs: Math.max(0, windowResetMs)
      };
    } else if (endpoint === 'batch') {
      results.batch = {
        withinLimit,
        requestsInWindow: recentRequests.length,
        windowResetMs: Math.max(0, windowResetMs)
      };
    }
  }

  return results;
}

async function getOptimizationSuggestions(quotaStatus: Awaited<ReturnType<typeof checkQuotaStatus>>): Promise<string[]> {
  const suggestions: string[] = [];
  const usageRatio = quotaStatus.quotaUsage.used / quotaStatus.quotaUsage.limit;
  
  if (usageRatio >= QUOTA_CRITICAL_THRESHOLD) {
    suggestions.push("CRITICAL: API quota nearly exhausted. All requests will use fallback data until reset.");
    suggestions.push("Consider implementing request batching to reduce quota consumption.");
    suggestions.push("Enable aggressive caching to minimize API calls.");
  } else if (usageRatio >= QUOTA_WARNING_THRESHOLD) {
    suggestions.push("WARNING: High quota usage detected. Monitor usage closely.");
    suggestions.push("Consider reducing search frequency or batch sizes.");
    suggestions.push("Implement client-side caching to reduce repeated requests.");
  } else if (usageRatio >= 0.5) {
    suggestions.push("Moderate quota usage. Consider optimizing request patterns.");
    suggestions.push("Use batch requests when fetching multiple video details.");
  } else {
    suggestions.push("Quota usage is healthy. Current optimization strategies are working well.");
  }
  
  // Time-based suggestions (now using Pacific Time)
  const hoursUntilReset = quotaStatus.resetTimeRemaining / (1000 * 60 * 60);
  const resetTimePacific = new Date(quotaStatus.quotaUsage.resetTime);
  const resetTimePacificString = resetTimePacific.toLocaleString("en-US", { 
    timeZone: "America/Los_Angeles",
    timeZoneName: "short"
  });
  
  if (hoursUntilReset < 6 && usageRatio > 0.8) {
    suggestions.push(`Only ${hoursUntilReset.toFixed(1)} hours until quota reset at ${resetTimePacificString}. Consider reducing API usage.`);
  }
  
  suggestions.push(`Quota resets at midnight Pacific Time (${resetTimePacificString}), synchronized with Google's YouTube API reset schedule.`);
  
  return suggestions;
}

async function getHealthStatus(): Promise<{
  overall: 'healthy' | 'degraded' | 'critical';
  youtubeApi: 'operational' | 'limited' | 'unavailable';
  caching: 'operational' | 'degraded';
  fallbacks: 'ready' | 'active' | 'failed';
}> {
  const quotaStatus = await checkQuotaStatus();
  const rateLimits = checkRateLimits();
  
  let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';
  let youtubeApi: 'operational' | 'limited' | 'unavailable' = 'operational';
  let caching: 'operational' | 'degraded' = 'operational';
  let fallbacks: 'ready' | 'active' | 'failed' = 'ready';
  
  // Check YouTube API status
  if (!quotaStatus.canUseAPI) {
    youtubeApi = 'unavailable';
    overall = 'critical';
    fallbacks = 'active';
  } else if (quotaStatus.warningLevel === 'warning' || !rateLimits.search.withinLimit || !rateLimits.batch.withinLimit) {
    youtubeApi = 'limited';
    overall = 'degraded';
  }
  
  // Check for recent fallback usage (last 5 minutes)
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentFallbackEvents = await db
    .selectFrom('youtube_quota_events')
    .selectAll()
    .where('timestamp', '>=', fiveMinutesAgo)
    .where('event_type', '=', 'fallback_triggered')
    .execute();
  
  if (recentFallbackEvents.length > 0 && fallbacks === 'ready') {
    fallbacks = 'active';
    if (overall === 'healthy') {
      overall = 'degraded';
    }
  }
  
  return { overall, youtubeApi, caching, fallbacks };
}

export async function handle(request: Request) {
  try {
    console.log("YouTube quota monitoring endpoint called");
    
    const url = new URL(request.url);
    const includeEvents = url.searchParams.get('includeEvents') === 'true';
    const eventLimit = Math.min(parseInt(url.searchParams.get('eventLimit') || '10'), 50);
    
    console.log(`Quota check requested. Include events: ${includeEvents}, Event limit: ${eventLimit}`);
    
    const quotaStatus = await checkQuotaStatus();
    const rateLimits = checkRateLimits();
    const healthStatus = await getHealthStatus();
    const optimizationSuggestions = await getOptimizationSuggestions(quotaStatus);
    
    // Calculate consumption statistics
    const usageRatio = quotaStatus.quotaUsage.used / quotaStatus.quotaUsage.limit;
    const remainingQuota = quotaStatus.quotaUsage.limit - quotaStatus.quotaUsage.used;
    const estimatedRequestsRemaining = {
      search: Math.floor(remainingQuota / QUOTA_COSTS.search),
      batch: Math.floor(remainingQuota / QUOTA_COSTS.videos)
    };
    
    // Get recent events if requested
    const recentEvents = includeEvents 
      ? await getRecentQuotaEvents(eventLimit)
      : [];
    
    const totalEventsLogged = await getTotalEventsCount();
    
    // Pacific Time information for response
    const nowPacific = getPacificTime();
    const resetTimePacific = new Date(quotaStatus.quotaUsage.resetTime);
    const pacificTimeInfo = {
      currentPacificTime: nowPacific.toLocaleString("en-US", { 
        timeZone: "America/Los_Angeles",
        timeZoneName: "short"
      }),
      resetTimePacific: resetTimePacific.toLocaleString("en-US", { 
        timeZone: "America/Los_Angeles",
        timeZoneName: "short"
      })
    };
    
    console.log(`Quota status: ${quotaStatus.warningLevel}, Used: ${quotaStatus.quotaUsage.used}/${quotaStatus.quotaUsage.limit} (${(usageRatio * 100).toFixed(1)}%)`);
    console.log(`Health status: ${healthStatus.overall}, YouTube API: ${healthStatus.youtubeApi}, Fallbacks: ${healthStatus.fallbacks}`);
    console.log(`Pacific Time sync: Current ${pacificTimeInfo.currentPacificTime}, Reset ${pacificTimeInfo.resetTimePacific}`);
    
    const response = {
      quota: {
        used: quotaStatus.quotaUsage.used,
        limit: quotaStatus.quotaUsage.limit,
        remaining: remainingQuota,
        usagePercentage: Math.round(usageRatio * 100),
        resetTime: new Date(quotaStatus.quotaUsage.resetTime).toISOString(),
        resetTimeRemaining: quotaStatus.resetTimeRemaining,
        hoursUntilReset: quotaStatus.resetTimeRemaining / (1000 * 60 * 60),
        pacificTimeInfo
      },
      status: {
        canUseAPI: quotaStatus.canUseAPI,
        warningLevel: quotaStatus.warningLevel,
        fallbackMode: quotaStatus.fallbackMode,
        health: healthStatus
      },
      rateLimits: {
        search: {
          ...rateLimits.search,
          limit: RATE_LIMIT_WINDOWS.search.requests,
          windowMs: RATE_LIMIT_WINDOWS.search.windowMs
        },
        batch: {
          ...rateLimits.batch,
          limit: RATE_LIMIT_WINDOWS.batch.requests,
          windowMs: RATE_LIMIT_WINDOWS.batch.windowMs
        }
      },
      consumption: {
        quotaCosts: QUOTA_COSTS,
        estimatedRequestsRemaining,
        dailyUsagePattern: {
          currentHour: new Date().getHours(),
          usageToday: quotaStatus.quotaUsage.used,
          projectedDailyUsage: quotaStatus.quotaUsage.used * (24 / (24 - (quotaStatus.resetTimeRemaining / (1000 * 60 * 60))))
        }
      },
      optimization: {
        suggestions: optimizationSuggestions,
        cacheEfficiency: {
          // This would be calculated from actual cache hit rates in a real implementation
          estimatedHitRate: 0.75,
          estimatedSavings: Math.round(quotaStatus.quotaUsage.used * 0.75)
        }
      },
      events: recentEvents,
      metadata: {
        timestamp: new Date().toISOString(),
        totalEventsLogged,
        monitoringActive: true,
        timezoneSync: {
          usesPacificTime: true,
          syncedWithGoogle: true,
          currentPacificTime: pacificTimeInfo.currentPacificTime,
          nextResetPacific: pacificTimeInfo.resetTimePacific
        }
      }
    };
    
    // Set appropriate cache headers
    const cacheHeaders = {
      "Cache-Control": "no-cache, must-revalidate", // Always get fresh quota data
      "Vary": "Accept-Encoding"
    };
    
    return Response.json(response, { 
      status: 200,
      headers: cacheHeaders
    });
    
  } catch (error) {
    console.error("YouTube quota monitoring endpoint error:", error);
    
    if (error instanceof Error) {
      // Provide more specific error messages for constraint violations
      let errorMessage = error.message;
      if (error.message.includes('duplicate key')) {
        errorMessage = "Quota tracking record conflict detected. This can happen during high concurrent access or timezone transitions. Please retry the request.";
      }
      
      return Response.json(
        { 
          error: "Quota monitoring failed", 
          message: errorMessage,
          timestamp: new Date().toISOString(),
          retryable: error.message.includes('duplicate key')
        }, 
        { status: 500 }
      );
    }
    
    return Response.json(
      { 
        error: "Internal server error", 
        message: "An unexpected error occurred while monitoring quota",
        timestamp: new Date().toISOString(),
        retryable: false
      }, 
      { status: 500 }
    );
  }
}