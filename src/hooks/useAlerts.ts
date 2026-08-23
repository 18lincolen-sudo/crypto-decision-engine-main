
import { useState, useCallback } from 'react';
import { toast } from '@/hooks/use-toast';

export interface Alert {
  id: string;
  type: 'price' | 'volume' | 'news' | 'technical';
  symbol: string;
  message: string;
  timestamp: Date;
  priority: 'low' | 'medium' | 'high';
  sound?: boolean;
}

export function useAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const playAlertSound = useCallback((priority: Alert['priority']) => {
    if (!soundEnabled) return;

    // Create audio context for different alert sounds
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Different frequencies for different priorities
    const frequencies = {
      low: 440,    // A4
      medium: 523, // C5
      high: 659    // E5
    };

    oscillator.frequency.setValueAtTime(frequencies[priority], audioContext.currentTime);
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
  }, [soundEnabled]);

  const addAlert = useCallback((alert: Omit<Alert, 'id' | 'timestamp'>) => {
    const newAlert: Alert = {
      ...alert,
      id: Date.now().toString(),
      timestamp: new Date()
    };

    setAlerts(prev => [newAlert, ...prev.slice(0, 49)]); // Keep last 50 alerts

    // Show toast notification
    toast({
      title: `התראה ${alert.symbol}`,
      description: alert.message,
      variant: alert.priority === 'high' ? 'destructive' : 'default'
    });

    // Play sound
    if (alert.sound !== false) {
      playAlertSound(alert.priority);
    }
  }, [playAlertSound]);

  const clearAlert = useCallback((id: string) => {
    setAlerts(prev => prev.filter(alert => alert.id !== id));
  }, []);

  const clearAllAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  return {
    alerts,
    addAlert,
    clearAlert,
    clearAllAlerts,
    soundEnabled,
    setSoundEnabled
  };
}
