"use client";

import { createContext, useContext, useCallback, useRef, useState, useEffect, ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { postYoutubeSearch } from "../endpoints/youtube/search_POST.schema";
import { postYoutubeBatch } from "../endpoints/youtube/batch_POST.schema";
import { getYoutubeQuota } from "../endpoints/youtube/quota_GET.schema";
import type { InputType as SearchInputType, OutputType as SearchOutputType } from "../endpoints/youtube/search_POST.schema";
import type { InputType as BatchInputType, OutputType as BatchOutputType } from "../endpoints/youtube/batch_POST.schema";
import type { OutputType as QuotaOutputType } from "../endpoints/youtube/quota_GET.schema";

// Types for the manager
type CacheLayer = 'memory' | 'query' | 'storage';
type FallbackMode = 'api' | 'curated' | 'static' | 'emergency';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  layer: CacheLayer;
}

interface YouTubeApiManagerState {
  quotaStatus: QuotaOutputType | null;
  fallbackMode: FallbackMode;
  isOnline: boolean;
  rateLimitStatus: {
    search: { blocked: boolean; resetTime: number };
    batch: { blocked: boolean; resetTime: number };
  };
  cacheStats: {
    hits: number;
    misses: number;
    hitRate: number;
  };
}

interface YouTubeApiManagerContextType {
  state: YouTubeApiManagerState;
  searchMusic: (params: SearchInputType) => Promise<SearchOutputType>;
  batchFetchVideos: (params: BatchInputType) => Promise<BatchOutputType>;
  refreshQuotaStatus: () => Promise<void>;
  switchFallbackMode: (mode: FallbackMode) => void;
  clearCache: (layer?: CacheLayer) => void;
  getCacheStats: () => YouTubeApiManagerState['cacheStats'];
}

// Constants
const CACHE_TTLS = {
  search: 10 * 60 * 1000, // 10 minutes
  batch: 60 * 60 * 1000,  // 1 hour
  quota: 30 * 1000,       // 30 seconds
} as const;

const RATE_LIMIT_DELAYS = {
  search: 6 * 1000,  // 6 seconds between search requests
  batch: 12 * 1000,  // 12 seconds between batch requests
} as const;

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff

// Context
const YouTubeApiManagerContext = createContext<YouTubeApiManagerContextType | null>(null);

// Memory cache implementation
class MemoryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private stats = { hits: 0, misses: 0 };

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      console.log(`Memory cache miss for key: ${key}`);
      return null;
    }

    if (Date.now() > entry.timestamp + entry.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      console.log(`Memory cache expired for key: ${key}`);
      return null;
    }

    this.stats.hits++;
    console.log(`Memory cache hit for key: ${key}`);
    return entry.data;
  }

  set<T>(key: string, data: T, ttl: number): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl,
      layer: 'memory'
    };
    
    this.cache.set(key, entry);
    console.log(`Memory cache set for key: ${key}, TTL: ${ttl}ms`);
  }

  clear(): void {
    this.cache.clear();
    console.log("Memory cache cleared");
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? this.stats.hits / total : 0
    };
  }
}

// Storage cache implementation (localStorage)
class StorageCache {
  private prefix = 'youtube_api_cache_';

  get<T>(key: string): T | null {
    try {
      const item = localStorage.getItem(this.prefix + key);
      if (!item) {
        console.log(`Storage cache miss for key: ${key}`);
        return null;
      }

      const entry: CacheEntry<T> = JSON.parse(item);
      
      if (Date.now() > entry.timestamp + entry.ttl) {
        localStorage.removeItem(this.prefix + key);
        console.log(`Storage cache expired for key: ${key}`);
        return null;
      }

      console.log(`Storage cache hit for key: ${key}`);
      return entry.data;
    } catch (error) {
      console.error(`Storage cache error for key ${key}:`, error);
      return null;
    }
  }

  set<T>(key: string, data: T, ttl: number): void {
    try {
      const entry: CacheEntry<T> = {
        data,
        timestamp: Date.now(),
        ttl,
        layer: 'storage'
      };
      
      localStorage.setItem(this.prefix + key, JSON.stringify(entry));
      console.log(`Storage cache set for key: ${key}, TTL: ${ttl}ms`);
    } catch (error) {
      console.error(`Storage cache set error for key ${key}:`, error);
    }
  }

  clear(): void {
    try {
      const keys = Object.keys(localStorage).filter(key => key.startsWith(this.prefix));
      keys.forEach(key => localStorage.removeItem(key));
      console.log("Storage cache cleared");
    } catch (error) {
      console.error("Storage cache clear error:", error);
    }
  }
}

// Multi-layer cache manager
class CacheManager {
  private memoryCache = new MemoryCache();
  private storageCache = new StorageCache();

  get<T>(key: string): T | null {
    // Try memory cache first
    let data = this.memoryCache.get<T>(key);
    if (data) return data;

    // Try storage cache
    data = this.storageCache.get<T>(key);
    if (data) {
      // Promote to memory cache
      this.memoryCache.set(key, data, CACHE_TTLS.search);
      return data;
    }

    return null;
  }

  set<T>(key: string, data: T, ttl: number): void {
    this.memoryCache.set(key, data, ttl);
    // Also store in localStorage for persistence
    this.storageCache.set(key, data, ttl);
  }

  clear(layer?: CacheLayer): void {
    if (!layer || layer === 'memory') {
      this.memoryCache.clear();
    }
    if (!layer || layer === 'storage') {
      this.storageCache.clear();
    }
  }

  getStats() {
    return this.memoryCache.getStats();
  }
}

// Rate limiter
class RateLimiter {
  private lastRequests = new Map<string, number>();

  async checkAndWait(operation: 'search' | 'batch'): Promise<void> {
    const now = Date.now();
    const lastRequest = this.lastRequests.get(operation) || 0;
    const delay = RATE_LIMIT_DELAYS[operation];
    const timeSinceLastRequest = now - lastRequest;

    if (timeSinceLastRequest < delay) {
      const waitTime = delay - timeSinceLastRequest;
      console.log(`Rate limiting ${operation}: waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastRequests.set(operation, Date.now());
  }

  getRateLimitStatus() {
    const now = Date.now();
    return {
      search: {
        blocked: now - (this.lastRequests.get('search') || 0) < RATE_LIMIT_DELAYS.search,
        resetTime: (this.lastRequests.get('search') || 0) + RATE_LIMIT_DELAYS.search
      },
      batch: {
        blocked: now - (this.lastRequests.get('batch') || 0) < RATE_LIMIT_DELAYS.batch,
        resetTime: (this.lastRequests.get('batch') || 0) + RATE_LIMIT_DELAYS.batch
      }
    };
  }
}

// Retry mechanism with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await operation();
      if (attempt > 0) {
        console.log(`Operation succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Operation attempt ${attempt + 1} failed:`, lastError.message);

      if (attempt < maxRetries - 1) {
        const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

// Provider component
export function YouTubeApiManagerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const cacheManager = useRef(new CacheManager());
  const rateLimiter = useRef(new RateLimiter());
  
  const [state, setState] = useState<YouTubeApiManagerState>({
    quotaStatus: null,
    fallbackMode: 'api',
    isOnline: navigator.onLine,
    rateLimitStatus: {
      search: { blocked: false, resetTime: 0 },
      batch: { blocked: false, resetTime: 0 }
    },
    cacheStats: { hits: 0, misses: 0, hitRate: 0 }
  });

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => setState(prev => ({ ...prev, isOnline: true }));
    const handleOffline = () => setState(prev => ({ ...prev, isOnline: false }));

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Update rate limit status periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const newRateLimitStatus = rateLimiter.current.getRateLimitStatus();
      const newCacheStats = cacheManager.current.getStats();
      
      setState(prev => {
        // Only update if values actually changed
        const rateLimitChanged = 
          prev.rateLimitStatus.search.blocked !== newRateLimitStatus.search.blocked ||
          prev.rateLimitStatus.batch.blocked !== newRateLimitStatus.batch.blocked;
        
        const cacheStatsChanged = 
          prev.cacheStats.hits !== newCacheStats.hits ||
          prev.cacheStats.misses !== newCacheStats.misses;
        
        if (!rateLimitChanged && !cacheStatsChanged) {
          return prev; // No change, return same reference
        }
        
        return {
          ...prev,
          rateLimitStatus: newRateLimitStatus,
          cacheStats: newCacheStats
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Quota monitoring query
  const { data: quotaData } = useQuery({
    queryKey: ['youtube', 'quota'],
    queryFn: () => getYoutubeQuota(),
    refetchInterval: 30000, // Refresh every 30 seconds
    staleTime: CACHE_TTLS.quota,
  });

  // Update quota status and fallback mode
  useEffect(() => {
    if (quotaData) {
      setState(prev => {
        const newFallbackMode: FallbackMode = 
          quotaData.status.fallbackMode ? 'curated' :
          quotaData.status.warningLevel === 'critical' ? 'static' :
          prev.isOnline ? 'api' : 'emergency';

        // Only update if values actually changed
        if (prev.quotaStatus === quotaData && prev.fallbackMode === newFallbackMode) {
          return prev; // No change, return same reference
        }

        return {
          ...prev,
          quotaStatus: quotaData,
          fallbackMode: newFallbackMode
        };
      });

      console.log(`Quota status updated: ${quotaData.quota.usagePercentage}% used, mode: ${quotaData.status.fallbackMode ? 'fallback' : 'api'}`);
    }
  }, [quotaData]);

  // Search music function with caching and fallback
  const searchMusic = useCallback(async (params: SearchInputType): Promise<SearchOutputType> => {
    const cacheKey = `search_${JSON.stringify(params)}`;
    
    // Try cache first
    const cached = cacheManager.current.get<SearchOutputType>(cacheKey);
    if (cached) {
      console.log(`Returning cached search results for: ${params.query}`);
      return cached;
    }

    console.log(`Searching for music: ${params.query}, genre: ${params.genre || 'none'}, maxResults: ${params.maxResults}`);

    // Check rate limiting
    await rateLimiter.current.checkAndWait('search');

    // Perform search with retry
    const result = await withRetry(async () => {
      return await postYoutubeSearch(params);
    });

    // Cache the result
    cacheManager.current.set(cacheKey, result, CACHE_TTLS.search);
    
    console.log(`Search completed: ${result.videos.length} results, fallback: ${result.metadata.fallbackUsed || 'none'}`);
    return result;
  }, []);

  // Batch fetch videos function with caching
  const batchFetchVideos = useCallback(async (params: BatchInputType): Promise<BatchOutputType> => {
    const cacheKey = `batch_${params.videoIds.sort().join(',')}`;
    
    // Try cache first
    const cached = cacheManager.current.get<BatchOutputType>(cacheKey);
    if (cached) {
      console.log(`Returning cached batch results for ${params.videoIds.length} videos`);
      return cached;
    }

    console.log(`Batch fetching ${params.videoIds.length} videos: ${params.videoIds.join(', ')}`);

    // Check rate limiting
    await rateLimiter.current.checkAndWait('batch');

    // Perform batch fetch with retry
    const result = await withRetry(async () => {
      return await postYoutubeBatch(params);
    });

    // Cache the result
    cacheManager.current.set(cacheKey, result, CACHE_TTLS.batch);
    
    console.log(`Batch fetch completed: ${result.videos.length}/${result.metadata.totalRequested} videos, cache hits: ${result.metadata.cacheHits}, fallback: ${result.metadata.fallbackUsed || 'none'}`);
    return result;
  }, []);

  // Refresh quota status
  const refreshQuotaStatus = useCallback(async () => {
    console.log("Manually refreshing quota status");
    await queryClient.invalidateQueries({ queryKey: ['youtube', 'quota'] });
  }, [queryClient]);

  // Switch fallback mode manually
  const switchFallbackMode = useCallback((mode: FallbackMode) => {
    console.log(`Manually switching fallback mode to: ${mode}`);
    setState(prev => ({ ...prev, fallbackMode: mode }));
  }, []);

  // Clear cache
  const clearCache = useCallback((layer?: CacheLayer) => {
    console.log(`Clearing cache${layer ? ` (${layer} layer)` : ' (all layers)'}`);
    
    if (!layer || layer === 'query') {
      queryClient.clear();
    }
    
    cacheManager.current.clear(layer);
    
    setState(prev => ({
      ...prev,
      cacheStats: cacheManager.current.getStats()
    }));
  }, [queryClient]);

  // Get cache stats
  const getCacheStats = useCallback(() => {
    return cacheManager.current.getStats();
  }, []);

  const contextValue: YouTubeApiManagerContextType = {
    state,
    searchMusic,
    batchFetchVideos,
    refreshQuotaStatus,
    switchFallbackMode,
    clearCache,
    getCacheStats
  };

  return (
    <YouTubeApiManagerContext.Provider value={contextValue}>
      {children}
    </YouTubeApiManagerContext.Provider>
  );
}

// Hook to use the YouTube API manager
export function useYouTubeApiManager() {
  const context = useContext(YouTubeApiManagerContext);
  
  if (!context) {
    throw new Error('useYouTubeApiManager must be used within a YouTubeApiManagerProvider');
  }
  
  return context;
}

// Individual hooks for specific operations
export function useYouTubeSearch() {
  const { searchMusic, state } = useYouTubeApiManager();
  
  return useMutation({
    mutationFn: searchMusic,
    onSuccess: (data) => {
      console.log(`Search mutation successful: ${data.videos.length} videos found`);
    },
    onError: (error) => {
      console.error('Search mutation failed:', error);
    }
  });
}

export function useYouTubeBatch() {
  const { batchFetchVideos, state } = useYouTubeApiManager();
  
  return useMutation({
    mutationFn: batchFetchVideos,
    onSuccess: (data) => {
      console.log(`Batch mutation successful: ${data.videos.length} videos fetched`);
    },
    onError: (error) => {
      console.error('Batch mutation failed:', error);
    }
  });
}

export function useYouTubeQuota() {
  const { state, refreshQuotaStatus } = useYouTubeApiManager();
  
  return {
    quotaStatus: state.quotaStatus,
    refreshQuotaStatus,
    fallbackMode: state.fallbackMode,
    isQuotaHealthy: state.quotaStatus?.status.warningLevel === 'normal',
    isQuotaCritical: state.quotaStatus?.status.warningLevel === 'critical'
  };
}

// Convenience hook for getting current API health
export function useYouTubeApiHealth() {
  const { state } = useYouTubeApiManager();
  
  return {
    isHealthy: state.isOnline && state.fallbackMode === 'api' && !state.rateLimitStatus.search.blocked,
    isOnline: state.isOnline,
    fallbackMode: state.fallbackMode,
    rateLimitStatus: state.rateLimitStatus,
    cacheStats: state.cacheStats,
    quotaWarningLevel: state.quotaStatus?.status.warningLevel || 'normal'
  };
}