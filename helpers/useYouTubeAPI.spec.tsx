import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { YouTubeApiManagerProvider } from './youTubeApiManager';
import { useYouTubeAPI } from './useYouTubeAPI';
import * as searchModule from '../endpoints/youtube/search_POST.schema';
import * as quotaModule from '../endpoints/youtube/quota_GET.schema';
import { ReactNode } from 'react';

// Helper function for testing assertions
function throwUnlessTest<T>(value: T): jasmine.Matchers<T> {
  return expect(value);
}

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

describe('useYouTubeAPI', () => {
  let wrapper: ReturnType<typeof createWrapper>;
  let mockPostYoutubeSearch: jasmine.Spy;
  let mockGetYoutubeQuota: jasmine.Spy;

  beforeEach(() => {
    wrapper = createWrapper();
    
    // Create spies
    mockPostYoutubeSearch = jasmine.createSpy('postYoutubeSearch');
    mockGetYoutubeQuota = jasmine.createSpy('getYoutubeQuota');

    // Set up spies on modules
    spyOn(searchModule, 'postYoutubeSearch').and.callFake(mockPostYoutubeSearch);
    spyOn(quotaModule, 'getYoutubeQuota').and.callFake(mockGetYoutubeQuota);
    
    // Reset all spies
    mockPostYoutubeSearch.calls.reset();
    mockGetYoutubeQuota.calls.reset();
    mockLocalStorage.getItem.calls.reset();
    mockLocalStorage.setItem.calls.reset();
    mockLocalStorage.removeItem.calls.reset();
    mockLocalStorage.clear.calls.reset();
  });

  describe('useYouTubeAPI hook', () => {
    it('should provide the expected interface', () => {
      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });
      
      expect(result.current).toBeDefined();
      expect(result.current.playlist).toBeDefined();
      expect(result.current.getCurrentTrack).toBeInstanceOf(Function);
      expect(result.current.nextTrack).toBeInstanceOf(Function);
      expect(result.current.previousTrack).toBeInstanceOf(Function);
      expect(result.current.loadLiveRadioTracks).toBeInstanceOf(Function);
      expect(result.current.loadGenreTracks).toBeInstanceOf(Function);
    });

    it('should have initial state', () => {
      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });
      
      expect(result.current.playlist.tracks.length).toBe(0);
      expect(result.current.playlist.currentIndex).toBe(0);
      expect(result.current.playlist.isLoading).toBe(false);
      expect(result.current.getCurrentTrack()).toBeNull();
    });
  });

  describe('live radio functionality', () => {
    it('should load live radio tracks successfully', async () => {
      const mockSearchResponse = {
        videos: [
          {
            videoId: 'radio123',
            title: 'Radio Song',
            channelTitle: 'Radio Artist',
            description: 'Radio description',
            thumbnails: {
              default: { url: 'radio-thumb.jpg' },
              medium: { url: 'radio-thumb-med.jpg' },
              high: { url: 'radio-thumb-high.jpg' }
            },
            publishedAt: '2023-01-01T00:00:00Z',
            source: 'youtube_api'
          }
        ],
        metadata: {
          query: 'popular music 2024',
          genre: null,
          maxResults: 20,
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

      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });

      await act(async () => {
        await result.current.loadLiveRadioTracks();
      });

      await waitFor(() => {
        expect(result.current.playlist.tracks.length).toBe(1);
      }, { timeout: 1000 });

      expect(result.current.playlist.tracks[0].title).toBe('Radio Song');
      expect(result.current.playlist.isLoading).toBe(false);
      expect(result.current.playlist.error).toBeNull();
    });

    it('should handle search errors gracefully', async () => {
      const error = new Error('API temporarily unavailable');
      mockPostYoutubeSearch.and.returnValue(Promise.reject(error));

      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });

      await act(async () => {
        try {
          await result.current.loadLiveRadioTracks();
        } catch (e) {
          // Expected to fail
        }
      });

      await waitFor(() => {
        expect(result.current.playlist.error).toBe('API temporarily unavailable');
      }, { timeout: 1000 });

      expect(result.current.playlist.isLoading).toBe(false);
      expect(result.current.hasError).toBe(true);
    });
  });

  describe('genre functionality', () => {
    it('should load genre-specific tracks', async () => {
      const mockSearchResponse = {
        videos: [
          {
            videoId: 'pop123',
            title: 'Pop Song',
            channelTitle: 'Pop Artist',
            description: 'Pop description',
            thumbnails: {
              default: { url: 'pop-thumb.jpg' },
              medium: { url: 'pop-thumb-med.jpg' },
              high: { url: 'pop-thumb-high.jpg' }
            },
            publishedAt: '2023-01-01T00:00:00Z',
            source: 'youtube_api'
          }
        ],
        metadata: {
          query: 'pop music popular',
          genre: 'pop',
          maxResults: 20,
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

      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });

      await act(async () => {
        await result.current.loadGenreTracks('pop');
      });

      await waitFor(() => {
        expect(result.current.playlist.tracks.length).toBe(1);
      }, { timeout: 1000 });

      expect(result.current.playlist.tracks[0].title).toBe('Pop Song');
      expect(result.current.playlist.isLoading).toBe(false);
    });
  });

  describe('navigation functionality', () => {
    it('should navigate between tracks', async () => {
      const mockSearchResponse = {
        videos: [
          {
            videoId: 'track1',
            title: 'Track 1',
            channelTitle: 'Artist 1',
            description: 'Description 1',
            thumbnails: { default: { url: 'thumb1.jpg' }, medium: { url: 'thumb1-med.jpg' }, high: { url: 'thumb1-high.jpg' } },
            publishedAt: '2023-01-01T00:00:00Z',
            source: 'youtube_api'
          },
          {
            videoId: 'track2',
            title: 'Track 2',
            channelTitle: 'Artist 2',
            description: 'Description 2',
            thumbnails: { default: { url: 'thumb2.jpg' }, medium: { url: 'thumb2-med.jpg' }, high: { url: 'thumb2-high.jpg' } },
            publishedAt: '2023-01-01T00:00:00Z',
            source: 'youtube_api'
          }
        ],
        metadata: {
          query: 'test',
          genre: null,
          maxResults: 20,
          actualResults: 2,
          fallbackUsed: null,
          quotaStatus: { used: 1100, limit: 10000, percentage: 11, warningLevel: 'normal' },
          timestamp: new Date().toISOString()
        }
      };

      mockPostYoutubeSearch.and.returnValue(Promise.resolve(mockSearchResponse));

      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });

      await act(async () => {
        await result.current.loadLiveRadioTracks();
      });

      // Should start at first track
      expect(result.current.getCurrentTrack()?.title).toBe('Track 1');

      // Move to next track
      act(() => {
        result.current.nextTrack();
      });

      expect(result.current.getCurrentTrack()?.title).toBe('Track 2');

      // Move to previous track
      act(() => {
        result.current.previousTrack();
      });

      expect(result.current.getCurrentTrack()?.title).toBe('Track 1');
    });
  });

  describe('cache functionality', () => {
    it('should use cached results on subsequent calls', async () => {
      const mockSearchResponse = {
        videos: [
          {
            videoId: 'cached123',
            title: 'Cached Song',
            channelTitle: 'Cached Artist',
            description: 'Cached description',
            thumbnails: { default: { url: 'cached-thumb.jpg' }, medium: { url: 'cached-thumb-med.jpg' }, high: { url: 'cached-thumb-high.jpg' } },
            publishedAt: '2023-01-01T00:00:00Z',
            source: 'youtube_api'
          }
        ],
        metadata: {
          query: 'pop music popular',
          genre: 'pop',
          maxResults: 20,
          actualResults: 1,
          fallbackUsed: null,
          quotaStatus: { used: 1200, limit: 10000, percentage: 12, warningLevel: 'normal' },
          timestamp: new Date().toISOString()
        }
      };

      mockPostYoutubeSearch.and.returnValue(Promise.resolve(mockSearchResponse));

      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });

      // First call - should hit API
      await act(async () => {
        await result.current.loadGenreTracks('pop');
      });

      // Second call - should use cache
      await act(async () => {
        await result.current.loadGenreTracks('pop');
      });

      // API should only be called once due to caching
      expect(mockPostYoutubeSearch).toHaveBeenCalledTimes(1);
    });

    it('should clear cache when requested', () => {
      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });

      act(() => {
        result.current.clearCache();
      });

      // Should succeed without errors
      expect(result.current).toBeDefined();
    });

    it('should provide refresh functionality', () => {
      const { result } = renderHook(() => useYouTubeAPI(), { wrapper });

      expect(result.current.refreshPlaylist).toBeInstanceOf(Function);
    });
  });
});