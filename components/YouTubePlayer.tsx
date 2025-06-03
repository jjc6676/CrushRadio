"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import YouTube, { YouTubeEvent, YouTubePlayer as YTPlayer } from "react-youtube";
import styles from "./YouTubePlayer.module.css";

interface YouTubePlayerProps {
  videoId?: string;
  onReady?: (player: YTPlayer) => void;
  onStateChange?: (event: YouTubeEvent) => void;
  onEnd?: () => void;
  onError?: () => void;
  isPlaying?: boolean;
  volume?: number;
  className?: string;
}

export const YouTubePlayer: React.FC<YouTubePlayerProps> = ({
  videoId,
  onReady,
  onStateChange,
  onEnd,
  onError,
  isPlaying = false,
  volume = 70,
  className = "",
}) => {
  const playerRef = useRef<YTPlayer | null>(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [currentVideoId, setCurrentVideoId] = useState<string | undefined>(videoId);
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const [pendingPlay, setPendingPlay] = useState(false);
  const [audioContextUnlocked, setAudioContextUnlocked] = useState(false);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isLoadingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const unlockAttemptRef = useRef(0);
  const forceUnlockOnNextPlay = useRef(false);

  // Detect iOS devices
  const isIOS = useCallback(() => {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);

  // Debug logging for mobile audio issues
  const debugLog = useCallback((message: string, data?: any) => {
    if (isIOS()) {
      console.log(`[iOS Audio Debug] ${message}`, data || '');
    }
  }, [isIOS]);

  // Force audio context activation for iOS - more aggressive approach
  const forceAudioContextActivation = useCallback(async (forceAttempt = false) => {
    if (!isIOS()) return true;
    if (audioContextUnlocked && !forceAttempt) return true;

    try {
      unlockAttemptRef.current++;
      debugLog(`Audio context unlock attempt #${unlockAttemptRef.current} (forced: ${forceAttempt})`);

      // Create or get existing audio context
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        debugLog('Created new audio context', { state: audioContextRef.current.state });
      }

      const ctx = audioContextRef.current;
      
      // Resume if suspended
      if (ctx.state === 'suspended') {
        await ctx.resume();
        debugLog('Audio context resumed', { state: ctx.state });
      }

      // Create multiple silent audio buffers with different approaches
      try {
        // Method 1: Standard silent buffer
        const buffer1 = ctx.createBuffer(1, 1, 22050);
        const source1 = ctx.createBufferSource();
        source1.buffer = buffer1;
        source1.connect(ctx.destination);
        source1.start(0);
        debugLog('Method 1: Standard silent buffer played');
      } catch (e) {
        debugLog('Method 1 failed', e);
      }

      try {
        // Method 2: Longer buffer with gain control
        const buffer2 = ctx.createBuffer(2, ctx.sampleRate * 0.1, ctx.sampleRate);
        const source2 = ctx.createBufferSource();
        const gainNode = ctx.createGain();
        source2.buffer = buffer2;
        gainNode.gain.setValueAtTime(0.01, ctx.currentTime);
        source2.connect(gainNode);
        gainNode.connect(ctx.destination);
        source2.start(0);
        debugLog('Method 2: Longer buffer with gain played');
      } catch (e) {
        debugLog('Method 2 failed', e);
      }

      try {
        // Method 3: Oscillator approach
        const oscillator = ctx.createOscillator();
        const gainNode2 = ctx.createGain();
        oscillator.connect(gainNode2);
        gainNode2.connect(ctx.destination);
        gainNode2.gain.setValueAtTime(0.001, ctx.currentTime);
        oscillator.frequency.setValueAtTime(440, ctx.currentTime);
        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.01);
        debugLog('Method 3: Oscillator played');
      } catch (e) {
        debugLog('Method 3 failed', e);
      }
      
      // Wait longer and check multiple times
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        debugLog(`Checking audio context state (attempt ${i + 1}): ${ctx.state}`);
        
        if (ctx.state === 'running') {
          setAudioContextUnlocked(true);
          debugLog('Audio context successfully unlocked!');
          return true;
        }
      }
      
      debugLog('Audio context still not running after all attempts', { state: ctx.state });
      return false;
    } catch (error) {
      debugLog('Error during audio context activation', error);
      return false;
    }
  }, [isIOS, audioContextUnlocked, debugLog]);

  // Handle user interaction for iOS audio unlock - more aggressive
  const handleUserInteraction = useCallback(async (fromPlayButton = false) => {
    if (isIOS()) {
      debugLog(`User interaction detected (from play button: ${fromPlayButton})`);
      
      if (!hasUserInteracted) {
        setHasUserInteracted(true);
        debugLog('First user interaction detected, enabling audio context');
      }
      
      // Always attempt audio context activation on iOS user interactions
      const unlocked = await forceAudioContextActivation(fromPlayButton);
      
      // If this is from a play button or there's a pending play request, execute it now
      if ((fromPlayButton || pendingPlay) && playerRef.current && isPlayerReady) {
        debugLog('Executing play request', { 
          audioUnlocked: unlocked, 
          fromPlayButton, 
          pendingPlay 
        });
        try {
          await attemptPlayerStart();
          setPendingPlay(false);
          forceUnlockOnNextPlay.current = false;
        } catch (error) {
          debugLog('Error executing play request', error);
        }
      }
    }
  }, [hasUserInteracted, pendingPlay, isPlayerReady, debugLog, forceAudioContextActivation]);

  // Enhanced YouTube player start with multiple fallbacks and iOS-specific handling
  const attemptPlayerStart = useCallback(async () => {
    if (!playerRef.current) {
      throw new Error('Player not available');
    }

    const player = playerRef.current;
    debugLog('Attempting to start YouTube player');

    // On iOS, ensure audio context is unlocked before attempting play
    if (isIOS() && !audioContextUnlocked) {
      debugLog('Ensuring audio context is unlocked before YouTube play');
      const unlocked = await forceAudioContextActivation(true);
      if (!unlocked) {
        debugLog('Cannot start YouTube player - audio context not unlocked');
        throw new Error('Audio context not unlocked');
      }
    }

    try {
      // Method 1: Direct play with iOS-specific preparation
      if (isIOS()) {
        // On iOS, try to unmute first (in case it was muted)
        try {
          if (player.isMuted && player.isMuted()) {
            player.unMute();
            debugLog('Unmuted player for iOS');
          }
        } catch (e) {
          debugLog('Could not check/unmute player', e);
        }
      }
      
      await player.playVideo();
      debugLog('Direct playVideo() called');
      
      // Wait and check if it actually started
      await new Promise(resolve => setTimeout(resolve, 800)); // Longer wait for iOS
      const state = player.getPlayerState();
      
      if (state === YouTube.PlayerState.PLAYING) {
        debugLog('Player confirmed playing after direct play');
        return;
      }
      
      debugLog('Player not playing after direct play, trying fallbacks', { 
        state,
        stateName: {
          '-1': 'UNSTARTED',
          '0': 'ENDED', 
          '1': 'PLAYING',
          '2': 'PAUSED',
          '3': 'BUFFERING',
          '5': 'CUED'
        }[state] || 'UNKNOWN'
      });
    } catch (error) {
      debugLog('Direct playVideo() failed', error);
    }

    // Method 2: iOS-specific reload and play
    try {
      if (currentVideoId) {
        debugLog('Fallback: Reloading video and playing (iOS optimized)');
        
        // For iOS, cue first then load
        if (isIOS()) {
          await player.cueVideoById(currentVideoId);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        await player.loadVideoById(currentVideoId);
        await new Promise(resolve => setTimeout(resolve, 1500)); // Longer wait for iOS
        
        // Try to play multiple times
        for (let i = 0; i < 3; i++) {
          try {
            await player.playVideo();
            await new Promise(resolve => setTimeout(resolve, 300));
            
            const state = player.getPlayerState();
            if (state === YouTube.PlayerState.PLAYING) {
              debugLog(`Player confirmed playing after reload (attempt ${i + 1})`);
              return;
            }
          } catch (e) {
            debugLog(`Play attempt ${i + 1} failed`, e);
          }
        }
      }
    } catch (error) {
      debugLog('Reload and play fallback failed', error);
    }

    // Method 3: Seek to start and play with iOS optimizations
    try {
      debugLog('Fallback: Seeking to start and playing');
      await player.seekTo(0, true);
      await new Promise(resolve => setTimeout(resolve, 500)); // Longer wait
      
      // Multiple play attempts
      for (let i = 0; i < 3; i++) {
        try {
          await player.playVideo();
          await new Promise(resolve => setTimeout(resolve, 400));
          
          const state = player.getPlayerState();
          if (state === YouTube.PlayerState.PLAYING) {
            debugLog(`Player confirmed playing after seek (attempt ${i + 1})`);
            return;
          }
        } catch (e) {
          debugLog(`Seek play attempt ${i + 1} failed`, e);
        }
      }
    } catch (error) {
      debugLog('Seek and play fallback failed', error);
    }

    // Method 4: iOS-specific last resort - trigger another audio unlock and retry
    if (isIOS()) {
      try {
        debugLog('Last resort: Re-triggering audio unlock and retrying');
        await forceAudioContextActivation(true);
        await new Promise(resolve => setTimeout(resolve, 500));
        
        await player.playVideo();
        await new Promise(resolve => setTimeout(resolve, 800));
        
        const state = player.getPlayerState();
        if (state === YouTube.PlayerState.PLAYING) {
          debugLog('Player confirmed playing after audio re-unlock');
          return;
        }
      } catch (error) {
        debugLog('Audio re-unlock fallback failed', error);
      }
    }

    debugLog('All player start attempts failed');
    throw new Error('Failed to start YouTube player after all attempts');
  }, [debugLog, currentVideoId, isIOS, audioContextUnlocked, forceAudioContextActivation]);

  // Add global interaction listeners for iOS with more aggressive detection
  useEffect(() => {
    if (isIOS()) {
      const events = ['touchstart', 'touchend', 'click', 'keydown', 'pointerdown', 'mousedown', 'tap'];
      
      const handleInteraction = (event: Event) => {
        debugLog('Global user interaction detected', { type: event.type });
        handleUserInteraction(false);
      };
      
      // Add listeners to multiple targets for broader coverage
      const targets = [document, window, document.body];
      
      targets.forEach(target => {
        events.forEach(event => {
          target.addEventListener(event, handleInteraction, { passive: true, capture: true });
        });
      });

      return () => {
        targets.forEach(target => {
          events.forEach(event => {
            target.removeEventListener(event, handleInteraction, { capture: true });
          });
        });
      };
    }
  }, [handleUserInteraction, isIOS, debugLog]);

  // Handle player ready event with enhanced iOS initialization
  const handleReady = useCallback(async (event: YouTubeEvent) => {
    playerRef.current = event.target;
    setIsPlayerReady(true);
    
    debugLog('Player ready', {
      hasUserInteracted,
      isIOS: isIOS(),
      videoId: currentVideoId,
      audioContextUnlocked
    });
    
    // Set initial volume
    try {
      event.target.setVolume(volume);
    } catch (error) {
      debugLog('Error setting initial volume', error);
    }
    
    // Enhanced iOS initialization
    if (isIOS()) {
      try {
        // Ensure player is properly initialized for iOS
        debugLog('Performing iOS-specific player initialization');
        
        // Set playsinline explicitly via API if available
        if (typeof event.target.getIframe === 'function') {
          const iframe = event.target.getIframe();
          if (iframe) {
            iframe.setAttribute('playsinline', 'true');
            iframe.setAttribute('webkit-playsinline', 'true');
            debugLog('Set playsinline attributes on iframe');
          }
        }
        
        // Pre-load video to prepare for playback
        if (videoId) {
          event.target.cueVideoById(videoId);
          debugLog('Pre-cued video for iOS');
        }
      } catch (error) {
        debugLog('Error during iOS initialization', error);
      }
    }
    
    // Load initial video if provided
    if (videoId && videoId !== currentVideoId) {
      try {
        if (isIOS()) {
          // On iOS, cue first then load when user interacts
          event.target.cueVideoById(videoId);
          debugLog('Cued video for iOS (will load on interaction)');
        } else {
          event.target.loadVideoById(videoId);
          debugLog('Loaded video for non-iOS');
        }
        setCurrentVideoId(videoId);
      } catch (error) {
        debugLog('Error loading initial video', error);
      }
    }
    
    if (onReady) {
      onReady(event.target);
    }
  }, [onReady, volume, videoId, currentVideoId, hasUserInteracted, debugLog, isIOS, audioContextUnlocked]);

  // Handle player state changes
  const handleStateChange = useCallback((event: YouTubeEvent) => {
    debugLog('Player state change', {
      state: event.data,
      stateName: {
        '-1': 'UNSTARTED',
        '0': 'ENDED',
        '1': 'PLAYING',
        '2': 'PAUSED',
        '3': 'BUFFERING',
        '5': 'CUED'
      }[event.data] || 'UNKNOWN'
    });

    // Reset loading flag when video starts playing or pauses
    if (event.data === YouTube.PlayerState.PLAYING || 
        event.data === YouTube.PlayerState.PAUSED ||
        event.data === YouTube.PlayerState.ENDED) {
      isLoadingRef.current = false;
    }

    // Handle successful playback start on iOS
    if (event.data === YouTube.PlayerState.PLAYING && isIOS()) {
      debugLog('Audio playback started successfully on iOS');
      setPendingPlay(false);
    }

    if (onStateChange) {
      onStateChange(event);
    }
    
    // Handle video end
    if (event.data === YouTube.PlayerState.ENDED && onEnd) {
      onEnd();
    }
  }, [onStateChange, onEnd, debugLog, isIOS]);

  // Handle player errors with retry logic
  const handleError = useCallback((event: YouTubeEvent) => {
    isLoadingRef.current = false;
    debugLog('Player error', {
      error: event.data,
      errorType: {
        '2': 'Invalid video ID',
        '5': 'HTML5 player error',
        '100': 'Video not found',
        '101': 'Video not allowed in embedded player',
        '150': 'Video not allowed in embedded player (same as 101)'
      }[event.data] || 'Unknown error'
    });
    
    // Try to recover from certain errors by reloading the video
    if (event.data === 2 || event.data === 5 || event.data === 100 || event.data === 101 || event.data === 150) {
      // These are recoverable errors - invalid video ID, HTML5 player error, etc.
      setTimeout(() => {
        if (playerRef.current && currentVideoId && !isLoadingRef.current) {
          try {
            debugLog('Attempting error recovery by reloading video');
            isLoadingRef.current = true;
            playerRef.current.loadVideoById(currentVideoId);
          } catch (error) {
            debugLog('Error during video reload', error);
            isLoadingRef.current = false;
          }
        }
      }, 1000);
    }
    
    if (onError) {
      onError();
    }
  }, [onError, currentVideoId, debugLog]);

  // Debounced video loading to prevent rapid-fire updates
  const loadVideoDebounced = useCallback((newVideoId: string) => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    
    debounceTimeoutRef.current = setTimeout(() => {
      if (!isPlayerReady || !playerRef.current || isLoadingRef.current) return;
      
      try {
        debugLog('Loading new video', { videoId: newVideoId });
        isLoadingRef.current = true;
        playerRef.current.loadVideoById(newVideoId);
        setCurrentVideoId(newVideoId);
      } catch (error) {
        debugLog('Error loading video', error);
        isLoadingRef.current = false;
        if (onError) {
          onError();
        }
      }
    }, 100); // 100ms debounce
  }, [isPlayerReady, onError, debugLog]);

  // Handle video ID changes
  useEffect(() => {
    if (!videoId || videoId === currentVideoId) return;
    
    if (isPlayerReady && playerRef.current) {
      loadVideoDebounced(videoId);
    } else {
      // Player not ready yet, just update the current video ID
      setCurrentVideoId(videoId);
    }
  }, [videoId, currentVideoId, isPlayerReady, loadVideoDebounced]);

  // Update player state when isPlaying changes with enhanced iOS handling
  useEffect(() => {
    if (!isPlayerReady || !playerRef.current || isLoadingRef.current) return;
    
    const handlePlaybackChange = async () => {
      try {
        if (isPlaying) {
          debugLog('Play requested - triggering iOS audio unlock sequence');
          
          // On iOS, ALWAYS trigger the unlock sequence when play is requested
          if (isIOS()) {
            // Force unlock attempt on play button press
            forceUnlockOnNextPlay.current = true;
            
            // Trigger user interaction handler as if play button was pressed
            await handleUserInteraction(true);
            
            // If still no user interaction detected, set pending
            if (!hasUserInteracted) {
              debugLog('Play requested but no user interaction yet, setting pending play');
              setPendingPlay(true);
              return;
            }
            
            // Double-check audio context unlock
            if (!audioContextUnlocked) {
              debugLog('Play requested but audio context not unlocked, forcing unlock');
              const unlocked = await forceAudioContextActivation(true);
              if (!unlocked) {
                debugLog('Audio context unlock failed, setting pending play');
                setPendingPlay(true);
                return;
              }
            }
          }
          
          debugLog('Starting playback', { 
            hasUserInteracted, 
            audioContextUnlocked: isIOS() ? audioContextUnlocked : 'N/A',
            unlockAttempts: unlockAttemptRef.current
          });
          
          // Use enhanced start method for iOS
          if (isIOS()) {
            await attemptPlayerStart();
          } else {
            playerRef.current.playVideo();
          }
          setPendingPlay(false);
          forceUnlockOnNextPlay.current = false;
        } else {
          debugLog('Pausing playback');
          playerRef.current.pauseVideo();
          setPendingPlay(false);
          forceUnlockOnNextPlay.current = false;
        }
      } catch (error) {
        debugLog('Error controlling playback', error);
        if (isIOS() && isPlaying) {
          // On iOS, if play fails, set as pending for next interaction
          setPendingPlay(true);
          forceUnlockOnNextPlay.current = true;
        }
      }
    };

    handlePlaybackChange();
  }, [isPlaying, isPlayerReady, hasUserInteracted, debugLog, isIOS, audioContextUnlocked, forceAudioContextActivation, attemptPlayerStart, handleUserInteraction]);

  // Update volume when it changes
  useEffect(() => {
    if (!isPlayerReady || !playerRef.current) return;
    
    try {
      playerRef.current.setVolume(volume);
      debugLog('Volume updated', { volume });
    } catch (error) {
      debugLog('Error setting volume', error);
    }
  }, [volume, isPlayerReady, debugLog]);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  // YouTube player options with enhanced iOS-optimized settings
  const opts = {
    height: "0",
    width: "0",
    playerVars: {
      autoplay: 0, // Never autoplay - let user interaction control this
      controls: 0,
      disablekb: 1,
      fs: 0,
      iv_load_policy: 3,
      modestbranding: 1,
      rel: 0, // Don't show related videos
      playsinline: 1, // Critical for iOS - prevents fullscreen and maintains audio
      enablejsapi: 1, // Enable JavaScript API for better control
      origin: typeof window !== 'undefined' ? window.location.origin : undefined, // Help with CORS issues
      // Additional iOS-specific parameters
      widget_referrer: typeof window !== 'undefined' ? window.location.origin : undefined,
      html5: 1, // Force HTML5 player
      cc_load_policy: 0, // Don't show captions by default
      hl: 'en', // Set language
      // Ensure proper audio handling
      mute: 0, // Don't start muted
    },
  };

  return (
    <div className={`${styles.container} ${className}`}>
      <YouTube
        opts={opts}
        onReady={handleReady}
        onStateChange={handleStateChange}
        onError={handleError}
        className={styles.player}
      />

    </div>
  );
};