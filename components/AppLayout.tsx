"use client";

import React, { ReactNode, useEffect } from "react";
import { motion } from "framer-motion";
import { Music } from "lucide-react";
import styles from "./AppLayout.module.css";

interface AppLayoutProps {
  children: ReactNode;
  className?: string;
  isPlaying?: boolean;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ 
  children, 
  className = "",
  isPlaying = false
}) => {
  return (
    <div className={`${styles.container} ${className}`}>
      <div className={styles.backgroundContainer}>
        <motion.div 
          className={styles.wave}
          animate={{
            y: isPlaying ? [0, -15, 0] : 0,
            opacity: isPlaying ? [0.6, 0.8, 0.6] : 0.6,
          }}
          transition={{
            duration: 2.5,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
        <motion.div 
          className={styles.wave2}
          animate={{
            y: isPlaying ? [0, -20, 0] : 0,
            opacity: isPlaying ? [0.4, 0.6, 0.4] : 0.4,
          }}
          transition={{
            duration: 3.5,
            repeat: Infinity,
            ease: "easeInOut",
            delay: 0.5,
          }}
        />
      </div>
      
      <header className={styles.header}>
        <div className={styles.logo}>
          <Music size={28} />
          <h1>Crush Radio</h1>
        </div>
      </header>
      
      <main className={styles.content}>
        {children}
      </main>
    </div>
  );
};