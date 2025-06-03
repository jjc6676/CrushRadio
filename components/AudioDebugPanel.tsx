"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "./Button";
import { useIsMobile } from "../helpers/useIsMobile";
import { 
  ChevronDown, 
  ChevronUp, 
  Play, 
  Pause, 
  Volume2, 
  VolumeX, 
  Smartphone,
  AlertTriangle,
  CheckCircle,
  XCircle,
  RotateCcw
} from "lucide-react";
import styles from "./AudioDebugPanel.module.css";

interface AudioDebugPanelProps {
  className?: string;
  isVisible?: boolean;
  onToggleVisibility?: () => void;
  currentTrack?: { id: string; title: string } | null;
  isPlaying?: boolean;
  playerState?: string;
  hasUserInteracted?: boolean;
  audioErrors?: string[];
  audioContextUnlocked?: boolean;
  unlockAttempts?: number;
  onForceAudioUnlock?: () => Promise<void>;
}

interface DebugLog {
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export const AudioDebugPanel: React.FC<AudioDebugPanelProps> = ({
  className = "",
  isVisible = true,
  onToggleVisibility,
  currentTrack,
  isPlaying = false,
  playerState = "unknown",
  hasUserInteracted = false,
  audioErrors = [],
  audioContextUnlocked = false,
  unlockAttempts = 0,
  onForceAudioUnlock,
}) => {
  const isMobile = useIsMobile();
  const [isExpanded, setIsExpanded] = useState(false);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [audioContextState, setAudioContextState] = useState<string>("unknown");
  const [isTestingAudio, setIsTestingAudio] = useState(false);
  const [testAudioResult, setTestAudioResult] = useState<string | null>(null);
  const logsRef = useRef<HTMLDivElement>(null);

  // Detect iOS specifically
  const isIOS = useCallback(() => {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);

  // Add debug log
  const addLog = useCallback((level: 'info' | 'warning' | 'error', message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const newLog: DebugLog = { timestamp, level, message };
    
    setLogs(prev => {
      const updated = [...prev, newLog].slice(-50); // Keep last 50 logs
      return updated;
    });

    // Also log to console with iOS prefix
    const consoleMessage = `[iOS Audio Debug] ${message}`;
    switch (level) {
      case 'error':
        console.error(consoleMessage);
        break;
      case 'warning':
        console.warn(consoleMessage);
        break;
      default:
        console.log(consoleMessage);
    }
  }, []);

  // Initialize audio context monitoring
  useEffect(() => {
    if (!isIOS()) return;

    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      setAudioContext(ctx);
      setAudioContextState(ctx.state);
      
      addLog('info', `Audio context initialized: ${ctx.state}`);

      const handleStateChange = () => {
        setAudioContextState(ctx.state);
        addLog('info', `Audio context state changed: ${ctx.state}`);
      };

      ctx.addEventListener('statechange', handleStateChange);
      
      return () => {
        ctx.removeEventListener('statechange', handleStateChange);
      };
    } catch (error) {
      addLog('error', `Failed to initialize audio context: ${error}`);
    }
  }, [isIOS, addLog]);

  // Log player state changes
  useEffect(() => {
    if (isIOS()) {
      addLog('info', `Player state: ${playerState}, Playing: ${isPlaying}`);
    }
  }, [playerState, isPlaying, isIOS, addLog]);

  // Log user interaction changes
  useEffect(() => {
    if (isIOS()) {
      addLog(hasUserInteracted ? 'info' : 'warning', 
             `User interaction: ${hasUserInteracted ? 'detected' : 'waiting'}`);
    }
  }, [hasUserInteracted, isIOS, addLog]);

  // Log audio unlock changes
  useEffect(() => {
    if (isIOS()) {
      addLog(audioContextUnlocked ? 'info' : 'warning', 
             `Audio context unlocked: ${audioContextUnlocked ? 'yes' : 'no'}`);
    }
  }, [audioContextUnlocked, isIOS, addLog]);

  // Log unlock attempts
  useEffect(() => {
    if (isIOS() && unlockAttempts > 0) {
      addLog('info', `Audio unlock attempts: ${unlockAttempts}`);
    }
  }, [unlockAttempts, isIOS, addLog]);

  // Log track changes
  useEffect(() => {
    if (isIOS() && currentTrack) {
      addLog('info', `Track loaded: ${currentTrack.title} (${currentTrack.id})`);
    }
  }, [currentTrack, isIOS, addLog]);

  // Log audio errors
  useEffect(() => {
    if (isIOS() && audioErrors.length > 0) {
      audioErrors.forEach(error => {
        addLog('error', `Audio error: ${error}`);
      });
    }
  }, [audioErrors, isIOS, addLog]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  // Test audio functionality
  const testAudio = useCallback(async () => {
    if (!audioContext) {
      addLog('error', 'No audio context available for testing');
      return;
    }

    setIsTestingAudio(true);
    setTestAudioResult(null);
    addLog('info', 'Starting audio test...');

    try {
      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
        addLog('info', 'Audio context resumed');
      }

      // Create a simple test tone
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime); // Low volume
      
      oscillator.start();
      
      // Play for 500ms
      setTimeout(() => {
        oscillator.stop();
        setTestAudioResult('success');
        addLog('info', 'Audio test completed successfully');
        setIsTestingAudio(false);
      }, 500);

    } catch (error) {
      setTestAudioResult('error');
      addLog('error', `Audio test failed: ${error}`);
      setIsTestingAudio(false);
    }
  }, [audioContext, addLog]);

  // Clear logs
  const clearLogs = useCallback(() => {
    setLogs([]);
    addLog('info', 'Debug logs cleared');
  }, [addLog]);

  // Don't render on non-mobile devices unless forced visible
  if (!isMobile && !isVisible) {
    return null;
  }

  // Don't render if explicitly hidden
  if (!isVisible) {
    return null;
  }

  const getStatusIcon = (status: boolean | string, goodValue?: any) => {
    if (typeof status === 'boolean') {
      return status ? <CheckCircle className={styles.iconSuccess} /> : <XCircle className={styles.iconError} />;
    }
    
    if (typeof status === 'string') {
      if (goodValue && status === goodValue) {
        return <CheckCircle className={styles.iconSuccess} />;
      }
      if (status.includes('error') || status === 'suspended') {
        return <XCircle className={styles.iconError} />;
      }
      return <AlertTriangle className={styles.iconWarning} />;
    }
    
    return <AlertTriangle className={styles.iconWarning} />;
  };

  return (
    <div className={`${styles.container} ${className}`}>
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header} onClick={() => setIsExpanded(!isExpanded)}>
          <div className={styles.headerContent}>
            <Smartphone className={styles.headerIcon} />
            <span className={styles.headerTitle}>iOS Audio Debug</span>
            {audioErrors.length > 0 && (
              <span className={styles.errorBadge}>{audioErrors.length}</span>
            )}
          </div>
          <Button 
            variant="ghost" 
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
          >
            {isExpanded ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className={styles.content}>
            {/* Status Grid */}
            <div className={styles.statusGrid}>
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>User Interaction</span>
                <div className={styles.statusValue}>
                  {getStatusIcon(hasUserInteracted)}
                  <span>{hasUserInteracted ? 'Yes' : 'No'}</span>
                </div>
              </div>

              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Audio Context</span>
                <div className={styles.statusValue}>
                  {getStatusIcon(audioContextState, 'running')}
                  <span>{audioContextState}</span>
                </div>
              </div>

              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Audio Unlocked</span>
                <div className={styles.statusValue}>
                  {getStatusIcon(audioContextUnlocked)}
                  <span>{audioContextUnlocked ? 'Yes' : 'No'}</span>
                </div>
              </div>

              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Unlock Attempts</span>
                <div className={styles.statusValue}>
                  {getStatusIcon(unlockAttempts === 0 ? 'none' : unlockAttempts.toString())}
                  <span>{unlockAttempts}</span>
                </div>
              </div>

              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Player State</span>
                <div className={styles.statusValue}>
                  {getStatusIcon(playerState, 'PLAYING')}
                  <span>{playerState}</span>
                </div>
              </div>

              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>Playback</span>
                <div className={styles.statusValue}>
                  {isPlaying ? <Play className={styles.iconSuccess} /> : <Pause className={styles.iconWarning} />}
                  <span>{isPlaying ? 'Playing' : 'Paused'}</span>
                </div>
              </div>
            </div>

            {/* Current Track */}
            {currentTrack && (
              <div className={styles.trackInfo}>
                <span className={styles.trackLabel}>Current Track:</span>
                <span className={styles.trackTitle}>{currentTrack.title}</span>
                <span className={styles.trackId}>ID: {currentTrack.id}</span>
              </div>
            )}

            {/* Test Audio */}
            <div className={styles.testSection}>
              <div className={styles.testButtons}>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={testAudio}
                  disabled={isTestingAudio || !audioContext}
                >
                  {isTestingAudio ? (
                    <>
                      <Volume2 className={styles.spinning} />
                      Testing...
                    </>
                  ) : (
                    <>
                      <Volume2 />
                      Test Audio
                    </>
                  )}
                </Button>
                
                {onForceAudioUnlock && (
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={onForceAudioUnlock}
                  >
                    <Play />
                    Force Unlock
                  </Button>
                )}
              </div>
              
              {testAudioResult && (
                <div className={`${styles.testResult} ${styles[testAudioResult]}`}>
                  {testAudioResult === 'success' ? (
                    <>
                      <CheckCircle />
                      Audio test passed
                    </>
                  ) : (
                    <>
                      <XCircle />
                      Audio test failed
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Debug Logs */}
            <div className={styles.logsSection}>
              <div className={styles.logsHeader}>
                <span className={styles.logsTitle}>Debug Logs</span>
                <Button 
                  variant="ghost" 
                  size="icon-sm"
                  onClick={clearLogs}
                >
                  <RotateCcw />
                </Button>
              </div>
              
              <div className={styles.logs} ref={logsRef}>
                {logs.length === 0 ? (
                  <div className={styles.noLogs}>No logs yet...</div>
                ) : (
                  logs.map((log, index) => (
                    <div key={index} className={`${styles.logEntry} ${styles[log.level]}`}>
                      <span className={styles.logTime}>{log.timestamp}</span>
                      <span className={styles.logMessage}>{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Toggle Visibility */}
            {onToggleVisibility && (
              <div className={styles.actions}>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={onToggleVisibility}
                >
                  <VolumeX />
                  Hide Debug Panel
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};