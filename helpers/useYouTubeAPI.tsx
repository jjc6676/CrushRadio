"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useYouTubeApiManager, useYouTubeSearch, useYouTubeApiHealth } from "./youTubeApiManager";

// Types for YouTube API responses
interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  description?: string;
  publishedAt?: string;
  source?: string;
  duration?: string; // Duration in ISO 8601 format (PT4M13S) or seconds
}

interface PlaylistState {
  tracks: YouTubeVideo[];
  currentIndex: number;
  isLoading: boolean;
  error: string | null;
  fallbackMode: string | null;
}

interface LoadingState {
  isSearching: boolean;
  lastSearchQuery?: string;
  lastSearchGenre?: string;
}

export const useYouTubeAPI = () => {
  // Get YouTube API manager context
  const { state: apiState, searchMusic } = useYouTubeApiManager();
  const { isHealthy, fallbackMode, quotaWarningLevel } = useYouTubeApiHealth();

  // Cache for API responses to minimize calls
  const cacheRef = useRef<Record<string, { data: YouTubeVideo[]; timestamp: number }>>({});
  
  // Track played tracks for auto-refresh
  const playedTracksRef = useRef<number>(0);
  const AUTO_REFRESH_THRESHOLD = 5; // Refresh after 5 tracks
  
  // Loading state for better UX
  const [loadingState, setLoadingState] = useState<LoadingState>({
    isSearching: false
  });

  const [playlist, setPlaylist] = useState<PlaylistState>({
    tracks: [],
    currentIndex: 0,
    isLoading: false,
    error: null,
    fallbackMode: null,
  });

  // Update playlist state when API manager state changes
  useEffect(() => {
    setPlaylist(prev => ({
      ...prev,
      fallbackMode: apiState.fallbackMode
    }));
  }, [apiState.fallbackMode]);

  // Convert YouTube API response to our format
  const convertApiResponse = useCallback((apiVideos: any[]): YouTubeVideo[] => {
    return apiVideos.map(video => ({
      id: video.videoId,
      title: video.title,
      channelTitle: video.channelTitle,
      thumbnailUrl: video.thumbnails?.high?.url || video.thumbnails?.medium?.url || video.thumbnails?.default?.url || '',
      description: video.description,
      publishedAt: video.publishedAt,
      source: video.source,
      duration: video.duration // Include duration if available from API
    }));
  }, []);

  // Get tracks from cache or fetch new ones
  const getTracks = useCallback(
    async (genre?: string, bypassCache: boolean = false): Promise<YouTubeVideo[]> => {
      const cacheKey = genre || "random";
      const cachedData = cacheRef.current[cacheKey];
      const now = Date.now();
      
      // For Live Radio, use shorter TTL (5 minutes max)
      const cacheTTL = genre ? 10 * 60 * 1000 : 5 * 60 * 1000; // 10 min for genres, 5 min for live radio
      
      if (!bypassCache && cachedData && now - cachedData.timestamp < cacheTTL) {
        console.log(`Cache hit for key: ${cacheKey}`);
        return cachedData.data;
      }
      
      console.log(`Cache miss for key: ${cacheKey}, making API request`);
      
      try {
        // Prepare search query
        let query = "";
        if (genre) {
          // Genre-specific search
          query = `${genre} music popular`;
        } else {
          // Random/live radio - mix of popular music terms
          const randomQueries = [
            "popular music 2024",
            "hit songs",
            "top music",
            "trending songs",
            "best music",
            "chart toppers",
            "viral songs"
          ];
          query = randomQueries[Math.floor(Math.random() * randomQueries.length)];
        }

        // Use the stable searchMusic function from the manager
        const response = await searchMusic({
          query,
          genre: genre || undefined,
          maxResults: 20 // Get more results for better variety
        });

        console.log(`API request successful: ${response.videos.length} videos found, fallback: ${response.metadata.fallbackUsed || 'none'}`);

        // Convert API response to our format
        let tracks = convertApiResponse(response.videos);
        
        // For random/live radio, always shuffle and use time-based freshness
        if (!genre) {
          // Add time-based freshness filter - prefer newer content
          const now = Date.now();
          const tracksWithFreshness = tracks.map(track => ({
            ...track,
            freshnessScore: Math.max(0, 1 - (now - new Date(track.publishedAt).getTime()) / (365 * 24 * 60 * 60 * 1000))
          }));
          
          // Sort by freshness and randomize within freshness tiers
          tracksWithFreshness.sort((a, b) => {
            const freshnessA = Math.floor(a.freshnessScore * 3); // 0-2 tiers
            const freshnessB = Math.floor(b.freshnessScore * 3);
            if (freshnessA !== freshnessB) return freshnessB - freshnessA;
            return Math.random() - 0.5; // Random within same tier
          });
          
          tracks = tracksWithFreshness;
        } else {
          // For genres, still shuffle but less aggressively
          tracks.sort(() => Math.random() - 0.5);
        }
        
        // Take only what we need (5-10 tracks)
        const finalTracks = tracks.slice(0, genre ? 10 : 8);
        
        // Cache the results
        cacheRef.current[cacheKey] = {
          data: finalTracks,
          timestamp: now,
        };
        
        return finalTracks;
      } catch (error) {
        console.error(`API request failed for ${cacheKey}:`, error);
        
        // Return cached data even if expired, or empty array
        if (cachedData) {
          console.log(`Using expired cache for ${cacheKey} due to API failure`);
          return cachedData.data;
        }
        
        throw error;
      }
    },
    [searchMusic, convertApiResponse]
  );

  // Load tracks for Live Radio (random selection)
  const loadLiveRadioTracks = useCallback(async (forceRefresh: boolean = false) => {
    setPlaylist(prev => ({ ...prev, isLoading: true, error: null }));
    setLoadingState({ isSearching: true, lastSearchQuery: "live radio" });
    
    try {
      console.log("Loading live radio tracks...", forceRefresh ? "(forced refresh)" : "");
      const tracks = await getTracks(undefined, forceRefresh);
      
      setPlaylist({
        tracks,
        currentIndex: 0,
        isLoading: false,
        error: null,
        fallbackMode: apiState.fallbackMode,
      });
      
      // Reset played tracks counter on refresh
      if (forceRefresh) {
        playedTracksRef.current = 0;
      }
      
      console.log(`Live radio loaded: ${tracks.length} tracks, API mode: ${apiState.fallbackMode}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to load live radio tracks";
      console.error("Error loading live radio tracks:", errorMessage);
      
      setPlaylist(prev => ({ 
        ...prev, 
        isLoading: false, 
        error: errorMessage,
        fallbackMode: apiState.fallbackMode,
      }));
    } finally {
      setLoadingState({ isSearching: false });
    }
  }, [getTracks, apiState.fallbackMode]);

  // Load tracks for a specific genre
  const loadGenreTracks = useCallback(
    async (genre: string, forceRefresh: boolean = false) => {
      setPlaylist(prev => ({ ...prev, isLoading: true, error: null }));
      setLoadingState({ isSearching: true, lastSearchQuery: genre, lastSearchGenre: genre });
      
      try {
        console.log(`Loading tracks for genre: ${genre}`, forceRefresh ? "(forced refresh)" : "");
        const tracks = await getTracks(genre, forceRefresh);
        
        setPlaylist({
          tracks,
          currentIndex: 0,
          isLoading: false,
          error: null,
          fallbackMode: apiState.fallbackMode,
        });
        
        // Reset played tracks counter on refresh
        if (forceRefresh) {
          playedTracksRef.current = 0;
        }
        
        console.log(`Genre ${genre} loaded: ${tracks.length} tracks, API mode: ${apiState.fallbackMode}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : `Failed to load ${genre} tracks`;
        console.error(`Error loading ${genre} tracks:`, errorMessage);
        
        setPlaylist(prev => ({ 
          ...prev, 
          isLoading: false, 
          error: errorMessage,
          fallbackMode: apiState.fallbackMode,
        }));
      } finally {
        setLoadingState({ isSearching: false });
      }
    },
    [getTracks, apiState.fallbackMode]
  );

  // Get current track
  const getCurrentTrack = useCallback(() => {
    return playlist.tracks[playlist.currentIndex] || null;
  }, [playlist.tracks, playlist.currentIndex]);

  // Move to next track with auto-refresh logic
  const nextTrack = useCallback(() => {
    setPlaylist((prev) => {
      if (prev.tracks.length === 0) return prev;
      
      const nextIndex = (prev.currentIndex + 1) % prev.tracks.length;
      console.log(`Moving to next track: ${nextIndex}/${prev.tracks.length - 1}`);
      
      // Increment played tracks counter
      playedTracksRef.current += 1;
      
      // Auto-refresh if we've played enough tracks
      if (playedTracksRef.current >= AUTO_REFRESH_THRESHOLD) {
        console.log(`Auto-refreshing after ${playedTracksRef.current} tracks`);
        setTimeout(() => {
          if (loadingState.lastSearchGenre) {
            loadGenreTracks(loadingState.lastSearchGenre, true);
          } else {
            loadLiveRadioTracks(true);
          }
        }, 100); // Small delay to avoid UI conflicts
      }
      
      return { ...prev, currentIndex: nextIndex };
    });
  }, [loadingState.lastSearchGenre, loadGenreTracks, loadLiveRadioTracks]);

  // Move to previous track
  const previousTrack = useCallback(() => {
    setPlaylist((prev) => {
      if (prev.tracks.length === 0) return prev;
      
      const prevIndex = (prev.currentIndex - 1 + prev.tracks.length) % prev.tracks.length;
      console.log(`Moving to previous track: ${prevIndex}/${prev.tracks.length - 1}`);
      return { ...prev, currentIndex: prevIndex };
    });
  }, []);

  // Clear cache manually
  const clearCache = useCallback(() => {
    cacheRef.current = {};
    console.log("YouTube API cache cleared");
  }, []);

  // Retry last failed operation
  const retryLastOperation = useCallback(async () => {
    if (loadingState.lastSearchGenre) {
      await loadGenreTracks(loadingState.lastSearchGenre, true); // Force refresh on retry
    } else {
      await loadLiveRadioTracks(true); // Force refresh on retry
    }
  }, [loadingState.lastSearchGenre, loadGenreTracks, loadLiveRadioTracks]);

  // Refresh current playlist
  const refreshPlaylist = useCallback(async () => {
    console.log("Manually refreshing playlist");
    if (loadingState.lastSearchGenre) {
      await loadGenreTracks(loadingState.lastSearchGenre, true);
    } else {
      await loadLiveRadioTracks(true);
    }
  }, [loadingState.lastSearchGenre, loadGenreTracks, loadLiveRadioTracks]);

  return {
    // Core playlist functionality (maintains backward compatibility)
    playlist,
    getCurrentTrack,
    nextTrack,
    previousTrack,
    loadLiveRadioTracks,
    loadGenreTracks,
    
    // Extended functionality
    clearCache,
    retryLastOperation,
    refreshPlaylist,
    
    // Status information
    isSearching: loadingState.isSearching,
    apiHealth: {
      isHealthy,
      fallbackMode,
      quotaWarningLevel,
      isOnline: apiState.isOnline,
      rateLimitStatus: apiState.rateLimitStatus,
      cacheStats: apiState.cacheStats,
    },
    
    // Error recovery
    hasError: !!playlist.error,
    errorMessage: playlist.error,
  };
};