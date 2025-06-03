"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { Button } from "./Button";
import { Slider } from "./Slider";
import { Progress } from "./Progress";
import styles from "./MusicControls.module.css";

interface MusicControlsProps {
  isPlaying: boolean;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onVolumeChange: (volume: number) => void;
  trackInfo?: {
    title: string;
    artist: string;
    thumbnailUrl: string;
  };
  progress?: number;
  volume: number;
  className?: string;
}

export const MusicControls: React.FC<MusicControlsProps> = ({
  isPlaying,
  onPlayPause,
  onNext,
  onPrevious,
  onVolumeChange,
  trackInfo,
  progress = 0,
  volume = 70,
  className = "",
}) => {
  const [isMuted, setIsMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(volume);

  const handleVolumeToggle = () => {
    if (isMuted) {
      setIsMuted(false);
      onVolumeChange(prevVolume);
    } else {
      setPrevVolume(volume);
      setIsMuted(true);
      onVolumeChange(0);
    }
  };

  const handleVolumeChange = (values: number[]) => {
    const newVolume = values[0];
    onVolumeChange(newVolume);
    if (newVolume === 0) {
      setIsMuted(true);
    } else if (isMuted) {
      setIsMuted(false);
    }
  };

  return (
    <div className={`${styles.container} ${className}`}>
      <div className={styles.trackInfo}>
        {trackInfo?.thumbnailUrl && (
          <div className={styles.thumbnail}>
            <img src={trackInfo.thumbnailUrl} alt={trackInfo.title} />
          </div>
        )}
        <div className={styles.textInfo}>
          <h3 className={styles.title}>{trackInfo?.title || "Not Playing"}</h3>
          <p className={styles.artist}>{trackInfo?.artist || "Unknown Artist"}</p>
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.buttons}>
          <Button variant="ghost" size="icon-md" onClick={onPrevious}>
            <SkipBack />
          </Button>
          <Button 
            variant="primary" 
            size="icon-lg" 
            onClick={onPlayPause}
            className={styles.playButton}
          >
            {isPlaying ? <Pause /> : <Play />}
          </Button>
          <Button variant="ghost" size="icon-md" onClick={onNext}>
            <SkipForward />
          </Button>
        </div>
        
        <div className={styles.progressContainer}>
          <Progress value={progress} className={styles.progress} />
        </div>
        
        <div className={styles.equalizer}>
          {isPlaying && (
            <>
              {[1, 2, 3, 4, 5].map((i) => (
                <motion.div
                  key={i}
                  className={styles.equalizerBar}
                  animate={{
                    height: [
                      `${20 + Math.random() * 30}%`,
                      `${50 + Math.random() * 50}%`,
                      `${20 + Math.random() * 30}%`,
                    ],
                  }}
                  transition={{
                    duration: 0.8 + Math.random() * 0.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
              ))}
            </>
          )}
        </div>
      </div>

      <div className={styles.volumeControls}>
        <Button variant="ghost" size="icon-sm" onClick={handleVolumeToggle}>
          {isMuted || volume === 0 ? <VolumeX /> : <Volume2 />}
        </Button>
        <Slider
          value={[isMuted ? 0 : volume]}
          min={0}
          max={100}
          step={1}
          onValueChange={handleVolumeChange}
          className={styles.volumeSlider}
        />
      </div>
    </div>
  );
};