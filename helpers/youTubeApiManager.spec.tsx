import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { YouTubeApiManagerProvider, useYouTubeApiManager, useYouTubeSearch } from './youTubeApiManager';
import * as searchModule from '../endpoints/youtube/search_POST.schema';
import * as batchModule from '../endpoints/youtube/batch_POST.schema';
import * as quotaModule from '../endpoints/youtube/quota_GET.schema';
import { ReactNode } from 'react';

// Mock localStorage
const mockLocalStorage = {
  getItem: jasmine.createSpy('getItem').and.returnValue(null),
  setItem: jasmine.createSpy('setItem'),
  removeItem: jasmine.createSpy('removeItem'),
  clear: jasmine.createSpy('clear')
};

Object.defineProperty(window, 'localStorage', {
  value: mockLocalStorage,
  writable: true
});

// Test wrapper component
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <YouTubeApiManagerProvider>
          {children}
        </YouTubeApiManagerProvider>
      </QueryClientProvider>
    );
  };
}

describe('youTubeApiManager', () => {
  let wrapper: ReturnType<typeof createWrapper>;
  let mockPostYoutubeSearch: jasmine.Spy;
  let mockPostYoutubeBatch: jasmine.Spy;
  let mockGetYoutubeQuota: jasmine.Spy;

  beforeEach(() => {
    wrapper = createWrapper();
    
    // Create spies
    mockPostYoutubeSearch = jasmine.createSpy('postYoutubeSearch');
    mockPostYoutubeBatch = jasmine.createSpy('postYoutubeBatch');
    mockGetYoutubeQuota = jasmine.createSpy('getYoutubeQuota');

    // Set up spies on modules
    spyOn(searchModule, 'postYoutubeSearch').and.callFake(mockPostYoutubeSearch);
    spyOn(batchModule, 'postYoutubeBatch').and.callFake(mockPostYoutubeBatch);
    spyOn(quotaModule, 'getYoutubeQuota').and.callFake(mockGetYoutubeQuota);
    
    // Reset all spies
    mockPostYoutubeSearch.calls.reset();
    mockPostYoutubeBatch.calls.reset();
    mockGetYoutubeQuota.calls.reset();
    mockLocalStorage.getItem.calls.reset();
    mockLocalStorage.setItem.calls.reset();
    mockLocalStorage.removeItem.calls.reset();
    mockLocalStorage.clear.calls.reset();

    // Mock quota response
    mockGetYoutubeQuota.and.returnValue(Promise.resolve({
      quota: {
        used: 1000,
        limit: 10000,
        remaining: 9000,
        usagePercentage: 10,
        resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        resetTimeRemaining: 24 * 60 * 60 * 1000,
        hoursUntilReset: 24
      },
      status: {
        canUseAPI: true,
        warningLevel: 'normal' as const,
        fallbackMode: false,
        health: {
          overall: 'healthy' as const,
          youtubeApi: 'operational' as const,
          caching: 'operational' as const,
          fallbacks: 'ready' as const
        }
      },
      rateLimits: {
        search: {
          withinLimit: true,
          requestsInWindow: 2,
          windowResetMs: 30000,
          limit: 10,
          windowMs: 60000
        },
        batch: {
          withinLimit: true,
          requestsInWindow: 1,
          windowResetMs: 40000,
          limit: 5,
          windowMs: 60000
        }
      },
      consumption: {
        quotaCosts: { search: 100, videos: 1, playlists: 1, channels: 1 },
        estimatedRequestsRemaining: { search: 90, batch: 9000 },
        dailyUsagePattern: {
          currentHour: new Date().getHours(),
          usageToday: 1000,
          projectedDailyUsage: 2000
        }
      },
      optimization: {
        suggestions: ["Current optimization strategies are working well."],
        cacheEfficiency: { estimatedHitRate: 0.75, estimatedSavings: 750 }
      },
      events: [],
      metadata: {
        timestamp: new Date().toISOString(),
        totalEventsLogged: 0,
        monitoringActive: true
      }
    }));
  });

  describe('useYouTubeApiManager hook', () => {
    it('should provide access to the API manager context', () => {
      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });
      
      expect(result.current).toBeDefined();
      expect(result.current.state).toBeDefined();
      expect(result.current.searchMusic).toBeInstanceOf(Function);
      expect(result.current.batchFetchVideos).toBeInstanceOf(Function);
      expect(result.current.refreshQuotaStatus).toBeInstanceOf(Function);
    });

    it('should throw error when used outside provider', () => {
      expect(() => {
        renderHook(() => useYouTubeApiManager());
      }).toThrow('useYouTubeApiManager must be used within a YouTubeApiManagerProvider');
    });
  });

  describe('search functionality', () => {
    it('should perform search and cache results', async () => {
      const mockSearchResponse = {
        videos: [
          {
            videoId: 'test123',
            title: 'Test Song',
            channelTitle: 'Test Artist',
            description: 'Test description',
            thumbnails: {
              default: { url: 'test-thumb.jpg' },
              medium: { url: 'test-thumb-med.jpg' },
              high: { url: 'test-thumb-high.jpg' }
            },
            publishedAt: '2023-01-01T00:00:00Z',
            source: 'youtube_api'
          }
        ],
        metadata: {
          query: 'test song',
          genre: null,
          maxResults: 10,
          actualResults: 1,
          fallbackUsed: null,
          quotaStatus: {
            used: 1100,
            limit: 10000,
            percentage: 11,
            warningLevel: 'normal'
          },
          timestamp: new Date().toISOString()
        }
      };

      mockPostYoutubeSearch.and.returnValue(Promise.resolve(mockSearchResponse));

      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });

      let searchResult: any;
      await act(async () => {
        searchResult = await result.current.searchMusic({
          query: 'test song',
          maxResults: 10
        });
      });

      expect(mockPostYoutubeSearch).toHaveBeenCalledWith({
        query: 'test song',
        maxResults: 10
      });
      expect(searchResult.videos.length).toBe(1);
      expect(searchResult.videos[0].title).toBe('Test Song');
    });

    it('should use cached results on subsequent calls', async () => {
      const mockSearchResponse = {
        videos: [
          {
            videoId: 'cached123',
            title: 'Cached Song',
            channelTitle: 'Cached Artist',
            description: 'Cached description',
            thumbnails: {
              default: { url: 'cached-thumb.jpg' },
              medium: { url: 'cached-thumb-med.jpg' },
              high: { url: 'cached-thumb-high.jpg' }
            },
            publishedAt: '2023-01-01T00:00:00Z',
            source: 'youtube_api'
          }
        ],
        metadata: {
          query: 'cached song',
          genre: null,
          maxResults: 5,
          actualResults: 1,
          fallbackUsed: null,
          quotaStatus: {
            used: 1200,
            limit: 10000,
            percentage: 12,
            warningLevel: 'normal'
          },
          timestamp: new Date().toISOString()
        }
      };

      mockPostYoutubeSearch.and.returnValue(Promise.resolve(mockSearchResponse));

      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });

      const searchParams = { query: 'cached song', maxResults: 5 };

      // First call - should hit API
      await act(async () => {
        await result.current.searchMusic(searchParams);
      });

      // Second call - should use cache
      await act(async () => {
        await result.current.searchMusic(searchParams);
      });

      // API should only be called once
      expect(mockPostYoutubeSearch).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch functionality', () => {
    it('should perform batch fetch and cache results', async () => {
      const mockBatchResponse = {
        videos: [
          {
            videoId: 'batch1',
            title: 'Batch Song 1',
            channelTitle: 'Batch Artist 1',
            description: 'Batch description 1',
            duration: 'PT3M30S',
            thumbnails: {
              default: { url: 'batch1-thumb.jpg' },
              medium: { url: 'batch1-thumb-med.jpg' },
              high: { url: 'batch1-thumb-high.jpg' }
            },
            publishedAt: '2023-01-01T00:00:00Z',
            viewCount: '1000000',
            tags: ['pop', 'music'],
            cachedAt: new Date().toISOString(),
            source: 'youtube_api'
          }
        ],
        metadata: {
          totalRequested: 1,
          totalReturned: 1,
          cacheHits: 0,
          apiCalls: 1,
          fallbackUsed: null,
          quotaStatus: {
            used: 1201,
            limit: 10000,
            percentage: 12,
            warningLevel: 'normal'
          },
          timestamp: new Date().toISOString()
        }
      };

      mockPostYoutubeBatch.and.returnValue(Promise.resolve(mockBatchResponse));

      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });

      let batchResult: any;
      await act(async () => {
        batchResult = await result.current.batchFetchVideos({
          videoIds: ['batch1']
        });
      });

      expect(mockPostYoutubeBatch).toHaveBeenCalledWith({
        videoIds: ['batch1']
      });
      expect(batchResult.videos.length).toBe(1);
      expect(batchResult.videos[0].title).toBe('Batch Song 1');
    });
  });

  describe('cache management', () => {
    it('should clear cache when requested', async () => {
      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });

      await act(async () => {
        result.current.clearCache();
      });

      expect(mockLocalStorage.clear).toHaveBeenCalled();
    });

    it('should provide cache statistics', () => {
      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });

      const stats = result.current.getCacheStats();
      
      expect(stats).toBeDefined();
      expect(typeof stats.hits).toBe('number');
      expect(typeof stats.misses).toBe('number');
      expect(typeof stats.hitRate).toBe('number');
    });
  });

  describe('fallback mode switching', () => {
    it('should allow manual fallback mode switching', async () => {
      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });

      await act(async () => {
        result.current.switchFallbackMode('curated');
      });

      await waitFor(() => {
        expect(result.current.state.fallbackMode).toBe('curated');
      });
    });
  });

  describe('error handling and retry', () => {
    it('should retry failed requests with exponential backoff', async () => {
      const error = new Error('API temporarily unavailable');
      mockPostYoutubeSearch.and.returnValues(
        Promise.reject(error),
        Promise.reject(error),
        Promise.resolve({
          videos: [],
          metadata: {
            query: 'retry test',
            genre: null,
            maxResults: 10,
            actualResults: 0,
            fallbackUsed: 'curated_playlists',
            quotaStatus: {
              used: 1300,
              limit: 10000,
              percentage: 13,
              warningLevel: 'normal'
            },
            timestamp: new Date().toISOString()
          }
        })
      );

      const { result } = renderHook(() => useYouTubeApiManager(), { wrapper });

      await act(async () => {
        await result.current.searchMusic({
          query: 'retry test',
          maxResults: 10
        });
      });

      // Should have been called 3 times (2 failures + 1 success)
      expect(mockPostYoutubeSearch).toHaveBeenCalledTimes(3);
    });
  });
});