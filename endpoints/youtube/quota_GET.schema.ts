import { z } from "zod";

export const schema = z.object({
  includeEvents: z.boolean().optional().default(false),
  eventLimit: z.number().int().min(1).max(50).optional().default(10)
});

export type InputType = z.infer<typeof schema>;

export type OutputType = {
  quota: {
    used: number;
    limit: number;
    remaining: number;
    usagePercentage: number;
    resetTime: string;
    resetTimeRemaining: number;
    hoursUntilReset: number;
    pacificTimeInfo: {
      currentPacificTime: string;
      resetTimePacific: string;
    };
  };
  status: {
    canUseAPI: boolean;
    warningLevel: 'normal' | 'warning' | 'critical';
    fallbackMode: boolean;
    health: {
      overall: 'healthy' | 'degraded' | 'critical';
      youtubeApi: 'operational' | 'limited' | 'unavailable';
      caching: 'operational' | 'degraded';
      fallbacks: 'ready' | 'active' | 'failed';
    };
  };
  rateLimits: {
    search: {
      withinLimit: boolean;
      requestsInWindow: number;
      windowResetMs: number;
      limit: number;
      windowMs: number;
    };
    batch: {
      withinLimit: boolean;
      requestsInWindow: number;
      windowResetMs: number;
      limit: number;
      windowMs: number;
    };
  };
  consumption: {
    quotaCosts: {
      search: number;
      videos: number;
      playlists: number;
      channels: number;
    };
    estimatedRequestsRemaining: {
      search: number;
      batch: number;
    };
    dailyUsagePattern: {
      currentHour: number;
      usageToday: number;
      projectedDailyUsage: number;
    };
  };
  optimization: {
    suggestions: string[];
    cacheEfficiency: {
      estimatedHitRate: number;
      estimatedSavings: number;
    };
  };
  events: Array<{
    timestamp: string;
    eventType: 'api_call' | 'quota_warning' | 'quota_critical' | 'fallback_triggered' | 'quota_reset';
    quotaUsed: number;
    quotaLimit: number;
    endpoint?: string;
    fallbackType?: string;
    message: string;
  }>;
  metadata: {
    timestamp: string;
    totalEventsLogged: number;
    monitoringActive: boolean;
    timezoneSync: {
      usesPacificTime: boolean;
      syncedWithGoogle: boolean;
      currentPacificTime: string;
      nextResetPacific: string;
    };
  };
};

export const getYoutubeQuota = async (params?: { includeEvents?: boolean; eventLimit?: number }, init?: RequestInit): Promise<OutputType> => {
  const url = new URL(`/_api/youtube/quota`, window.location.origin);
  
  if (params?.includeEvents !== undefined) {
    url.searchParams.set('includeEvents', params.includeEvents.toString());
  }
  
  if (params?.eventLimit !== undefined) {
    url.searchParams.set('eventLimit', params.eventLimit.toString());
  }
  
  const result = await fetch(url.toString(), {
    method: "GET",
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
  });
  
  if (!result.ok) {
    const errorData = await result.json();
    throw new Error(errorData.message || `HTTP ${result.status}`);
  }
  
  return result.json();
};