"use client";

import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Radio, Music, RefreshCw, AlertTriangle, Wifi, WifiOff, Activity } from "lucide-react";
import { AppLayout } from "../components/AppLayout";
import { MusicControls } from "../components/MusicControls";
import { YouTubePlayer } from "../components/YouTubePlayer";
import { AudioDebugPanel } from "../components/AudioDebugPanel";
import { useYouTubeAPI } from "../helpers/useYouTubeAPI";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/Dialog";
import { ToggleGroup, ToggleGroupItem } from "../components/ToggleGroup";
import { Button } from "../components/Button";
import { Skeleton } from "../components/Skeleton";
import styles from "./_index.module.css";

// Expanded music genres to match backend support
const GENRES = [
  { id: "pop", name: "Pop", icon: "🎵" },
  { id: "rock", name: "Rock", icon: "🤘" },
  { id: "electronic", name: "Electronic", icon: "🎧" },
  { id: "hip-hop", name: "Hip-Hop", icon: "🎤" },
  { id: "jazz", name: "Jazz", icon: "🎺" },
  { id: "classical", name: "Classical", icon: "🎼" },
  { id: "country", name: "Country", icon: "🤠" },
  { id: "r&b", name: "R&B", icon: "🎶" },
  { id: "reggae", name: "Reggae", icon: "🌴" },
  { id: "folk", name: "Folk", icon: "🪕" },
  { id: "blues", name: "Blues", icon: "🎸" },
  { id: "metal", name: "Metal", icon: "⚡" },
];

export default function HomePage() {
  // Player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(70);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<"live" | "custom">("live");
  const [showGenreSelector, setShowGenreSelector] = useState(false);
  const [selectedGenre, setSelectedGenre] = useState<string>("pop");
  const [showApiStatus, setShowApiStatus] = useState(false);
  
  // Debug state for AudioDebugPanel
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const [playerState, setPlayerState] = useState<string>("unknown");
  const [audioErrors, setAudioErrors] = useState<string[]>([]);
  
  // YouTube API hook with enhanced features
  const { 
    playlist, 
    getCurrentTrack, 
    nextTrack, 
    previousTrack, 
    loadLiveRadioTracks, 
    loadGenreTracks,
    refreshPlaylist,
    isSearching,
    apiHealth,
    hasError,
    errorMessage,
    retryLastOperation
  } = useYouTubeAPI();
  
  // Current track info
  const currentTrack = getCurrentTrack();

  // Monitor user interactions for debug panel
  useEffect(() => {
    const handleUserInteraction = () => {
      if (!hasUserInteracted) {
        setHasUserInteracted(true);
      }
    };

    const events = ['touchstart', 'touchend', 'click', 'keydown'];
    events.forEach(event => {
      document.addEventListener(event, handleUserInteraction, { once: true, passive: true });
    });

    return () => {
      events.forEach(event => {
        document.removeEventListener(event, handleUserInteraction);
      });
    };
  }, [hasUserInteracted]);

  // Load initial tracks
  useEffect(() => {
    loadLiveRadioTracks();
  }, []); // Only run on mount to prevent excessive API calls

  // Handle mode change
  const handleModeChange = useCallback((newMode: "live" | "custom") => {
    setMode(newMode);
    if (newMode === "live") {
      loadLiveRadioTracks();
    } else {
      setShowGenreSelector(true);
    }
  }, [loadLiveRadioTracks]);

  // Handle genre selection
  const handleGenreSelect = useCallback((genreId: string) => {
    setSelectedGenre(genreId);
    setShowGenreSelector(false);
    loadGenreTracks(genreId);
  }, [loadGenreTracks]);

  // Handle track end
  const handleTrackEnd = useCallback(() => {
    nextTrack();
  }, [nextTrack]);

  // Handle play/pause
  const handlePlayPause = useCallback(() => {
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  // Handle volume change
  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume);
  }, []);

  // Get upcoming tracks (next 3-4 songs)
  const getUpcomingTracks = useCallback(() => {
    if (playlist.tracks.length <= 1) return [];
    
    const upcoming = [];
    for (let i = 1; i <= 4; i++) {
      const nextIndex = (playlist.currentIndex + i) % playlist.tracks.length;
      if (nextIndex !== playlist.currentIndex) {
        upcoming.push(playlist.tracks[nextIndex]);
      }
    }
    return upcoming.slice(0, 3); // Show max 3 upcoming tracks
  }, [playlist.tracks, playlist.currentIndex]);

  const upcomingTracks = getUpcomingTracks();

  // Handle retry operation
  const handleRetry = useCallback(async () => {
    try {
      await retryLastOperation();
      if (currentTrack) {
        setIsPlaying(true);
      }
    } catch (error) {
      console.error("Retry failed:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setAudioErrors(prev => [...prev.slice(-4), `Retry failed: ${errorMessage}`]);
    }
  }, [retryLastOperation, currentTrack]);
  
  // Simulate progress updates
  useEffect(() => {
    if (!isPlaying) return;
    
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 100) {
          handleTrackEnd();
          return 0;
        }
        return prev + 0.5;
      });
    }, 1000);
    
    return () => clearInterval(interval);
  }, [isPlaying, handleTrackEnd]);

  // Get fallback mode display info
  const getFallbackModeInfo = () => {
    switch (apiHealth.fallbackMode) {
      case 'api':
        return { label: 'YouTube API', color: 'var(--success)', icon: <Wifi size={14} /> };
      case 'curated':
        return { label: 'Curated Content', color: 'var(--warning)', icon: <Activity size={14} /> };
      case 'static':
        return { label: 'Offline Content', color: 'var(--error)', icon: <WifiOff size={14} /> };
      case 'emergency':
        return { label: 'Emergency Mode', color: 'var(--error)', icon: <AlertTriangle size={14} /> };
      default:
        return { label: 'Unknown', color: 'var(--muted-foreground)', icon: <AlertTriangle size={14} /> };
    }
  };

  const fallbackInfo = getFallbackModeInfo();

  return (
    <AppLayout isPlaying={isPlaying}>
      <div className={styles.container}>
        {/* API Status Bar */}
        <div className={styles.statusBar}>
          <div className={styles.apiStatus} onClick={() => setShowApiStatus(true)}>
            <span className={styles.statusIcon} style={{ color: fallbackInfo.color }}>
              {fallbackInfo.icon}
            </span>
            <span className={styles.statusText}>{fallbackInfo.label}</span>
            {apiHealth.quotaWarningLevel !== 'normal' && (
              <span className={styles.warningBadge}>
                {apiHealth.quotaWarningLevel === 'critical' ? '!' : '⚠'}
              </span>
            )}
          </div>
          {hasError && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              className={styles.retryButton}
              disabled={isSearching}
            >
              <RefreshCw size={14} className={isSearching ? styles.spinning : ''} />
              Retry
            </Button>
          )}
        </div>

        <div className={styles.modeSelector}>
          <ToggleGroup 
            type="single" 
            value={mode} 
            onValueChange={(value) => value && handleModeChange(value as "live" | "custom")}
            disabled={isSearching}
          >
            <ToggleGroupItem value="live">
              <Radio size={16} />
              <span>Live Radio</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="custom">
              <Music size={16} />
              <span>Custom Playlist</span>
            </ToggleGroupItem>
          </ToggleGroup>
          
          {/* Refresh Button */}
          {(currentTrack || hasError) && (
            <Button
              variant="outline"
              size="sm"
              onClick={refreshPlaylist}
              disabled={isSearching}
              className={styles.refreshButton}
            >
              <RefreshCw size={16} className={isSearching ? styles.spinning : ''} />
              Refresh {mode === "live" ? "Radio" : "Playlist"}
            </Button>
          )}
        </div>
        
        <div className={styles.playerInfo}>
          {isSearching ? (
            <div className={styles.loadingState}>
              <Skeleton className={styles.trackImageSkeleton} />
              <div className={styles.trackDetailsSkeleton}>
                <Skeleton className={styles.titleSkeleton} />
                <Skeleton className={styles.artistSkeleton} />
                <Skeleton className={styles.tagSkeleton} />
              </div>
            </div>
          ) : hasError ? (
            <div className={styles.errorState}>
              <AlertTriangle size={48} color="var(--error)" />
              <h3>Something went wrong</h3>
              <p>{errorMessage}</p>
              <Button onClick={handleRetry} disabled={isSearching}>
                <RefreshCw size={16} className={isSearching ? styles.spinning : ''} />
                Try Again
              </Button>
            </div>
          ) : currentTrack ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className={styles.nowPlaying}
            >
              <div className={styles.trackImage}>
                <img src={currentTrack.thumbnailUrl} alt={currentTrack.title} />
                {isPlaying && (
                  <div className={styles.playingIndicator}>
                    <span>PLAYING</span>
                  </div>
                )}
              </div>
              
              <div className={styles.trackDetails}>
                <h2>{currentTrack.title}</h2>
                <p>{currentTrack.channelTitle}</p>
                
                {mode === "custom" && selectedGenre && (
                  <div className={styles.genreTag}>
                    {GENRES.find(g => g.id === selectedGenre)?.icon} {GENRES.find(g => g.id === selectedGenre)?.name}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowGenreSelector(true)}
                      className={styles.changeGenreButton}
                    >
                      Change
                    </Button>
                  </div>
                )}
                
                {mode === "live" && (
                  <div className={styles.liveTag}>
                    <span className={styles.liveDot}></span> LIVE RADIO
                  </div>
                )}

                {/* Source indicator */}
                <div className={styles.sourceInfo}>
                  <span className={styles.sourceLabel}>Source:</span>
                  <span className={styles.sourceValue} style={{ color: fallbackInfo.color }}>
                    {fallbackInfo.icon}
                    {fallbackInfo.label}
                  </span>
                </div>
              </div>
            </motion.div>
          ) : (
            <div className={styles.noTrack}>
              <p>No track playing</p>
              <Button onClick={() => setIsPlaying(true)} disabled={isSearching}>
                Start Listening
              </Button>
            </div>
          )}
        </div>

        {/* Upcoming Songs Queue */}
        {currentTrack && upcomingTracks.length > 0 && (
          <div className={styles.upcomingQueue}>
            <h3 className={styles.queueTitle}>Up Next</h3>
            <div className={styles.queueList}>
              {upcomingTracks.map((track, index) => (
                <div key={`${track.id}-${index}`} className={styles.queueItem}>
                  <div className={styles.queueItemImage}>
                    <img src={track.thumbnailUrl} alt={track.title} />
                  </div>
                  <div className={styles.queueItemDetails}>
                    <div className={styles.queueItemTitle}>{track.title}</div>
                    <div className={styles.queueItemArtist}>{track.channelTitle}</div>
                  </div>
                  <div className={styles.queueItemNumber}>{index + 1}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* Genre Selector Dialog */}
        <Dialog open={showGenreSelector} onOpenChange={(open) => {
          // Prevent closing if no genre is selected in custom mode
          if (!open && mode === "custom" && !selectedGenre) {
            return;
          }
          setShowGenreSelector(open);
        }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {selectedGenre ? "Change Genre" : "Select a Genre"}
              </DialogTitle>
            </DialogHeader>
            <div className={styles.genreGrid}>
              {GENRES.map((genre) => (
                <Button 
                  key={genre.id}
                  variant={selectedGenre === genre.id ? "primary" : "outline"}
                  className={styles.genreButton}
                  onClick={() => handleGenreSelect(genre.id)}
                  disabled={isSearching}
                >
                  <span className={styles.genreIcon}>{genre.icon}</span>
                  {genre.name}
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* API Status Dialog */}
        <Dialog open={showApiStatus} onOpenChange={setShowApiStatus}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>API Status</DialogTitle>
            </DialogHeader>
            <div className={styles.apiStatusDetails}>
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Connection:</span>
                <span className={styles.statusValue}>
                  {apiHealth.isOnline ? (
                    <><Wifi size={16} color="var(--success)" /> Online</>
                  ) : (
                    <><WifiOff size={16} color="var(--error)" /> Offline</>
                  )}
                </span>
              </div>
              
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>API Health:</span>
                <span className={styles.statusValue}>
                  {apiHealth.isHealthy ? (
                    <><Activity size={16} color="var(--success)" /> Healthy</>
                  ) : (
                    <><AlertTriangle size={16} color="var(--warning)" /> Limited</>
                  )}
                </span>
              </div>
              
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Content Source:</span>
                <span className={styles.statusValue} style={{ color: fallbackInfo.color }}>
                  {fallbackInfo.icon}
                  {fallbackInfo.label}
                </span>
              </div>
              
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Quota Level:</span>
                <span className={styles.statusValue}>
                  {apiHealth.quotaWarningLevel === 'normal' && (
                    <span style={{ color: 'var(--success)' }}>Normal</span>
                  )}
                  {apiHealth.quotaWarningLevel === 'warning' && (
                    <span style={{ color: 'var(--warning)' }}>Warning</span>
                  )}
                  {apiHealth.quotaWarningLevel === 'critical' && (
                    <span style={{ color: 'var(--error)' }}>Critical</span>
                  )}
                </span>
              </div>
              
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Cache Hit Rate:</span>
                <span className={styles.statusValue}>
                  {Math.round(apiHealth.cacheStats.hitRate * 100)}%
                </span>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Audio Debug Panel */}
        <AudioDebugPanel
          currentTrack={currentTrack ? { 
            id: currentTrack.id, 
            title: currentTrack.title 
          } : null}
          isPlaying={isPlaying}
          playerState={playerState}
          hasUserInteracted={hasUserInteracted}
          audioErrors={audioErrors}
        />

        {/* YouTube Player (hidden) */}
        <YouTubePlayer
          videoId={currentTrack?.id}
          isPlaying={isPlaying}
          volume={volume}
          onEnd={handleTrackEnd}
          onStateChange={(event) => {
            const stateNames = {
              '-1': 'UNSTARTED',
              '0': 'ENDED',
              '1': 'PLAYING',
              '2': 'PAUSED',
              '3': 'BUFFERING',
              '5': 'CUED'
            };
            const stateName = stateNames[event.data as keyof typeof stateNames] || 'UNKNOWN';
            setPlayerState(stateName);
          }}
          onError={() => {
            setAudioErrors(prev => [...prev.slice(-4), 'YouTube player error']);
          }}
        />
        
        {/* Music Controls */}
        <MusicControls
          isPlaying={isPlaying}
          onPlayPause={handlePlayPause}
          onNext={nextTrack}
          onPrevious={previousTrack}
          onVolumeChange={handleVolumeChange}
          trackInfo={currentTrack ? {
            title: currentTrack.title,
            artist: currentTrack.channelTitle,
            thumbnailUrl: currentTrack.thumbnailUrl,
          } : undefined}
          progress={progress}
          volume={volume}
          className={styles.musicControls}
        />
      </div>
    </AppLayout>
  );
}