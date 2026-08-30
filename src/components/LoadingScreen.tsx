
import { useState, useEffect } from 'react';
import { Loader2, Zap } from 'lucide-react';

interface LoadingScreenProps {
  onLoadingComplete?: () => void;
  maxLoadingTime?: number;
}

const LOADING_STEPS = [
  { text: 'מתחבר לבורסות קריפטו...', delay: 800 },
  { text: 'טוען נתוני שוק בזמן אמת...', delay: 1000 },
  { text: 'מבצע ניתוח טכני מתקדם...', delay: 1200 },
  { text: 'מחשב מדדי RSI, MACD, Bollinger Bands...', delay: 900 },
  { text: 'מעבד נתוני Fear & Greed Index...', delay: 700 },
  { text: 'יוצר המלצות השקעה חכמות...', delay: 800 },
  { text: '🚀 מוכן לזינוק בשוק הקריפטו!', delay: 600 }
];

const ENCOURAGING_MESSAGES = [
  '💎 היום יכול להיות היום של הזהב שלך!',
  '📈 השקעה חכמה מתחילה בניתוח נכון',
  '🎯 הזדמנות מחכה למי שמוכן לתפוס אותה',
  '💰 בשוק הקריפטו, הסבלנות משתלמת',
  '🌟 כל מומחה היה פעם מתחיל - היום זה הקריאה שלך!'
];

const LoadingScreen = ({ onLoadingComplete, maxLoadingTime = 15000 }: LoadingScreenProps) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [displayedText, setDisplayedText] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [isComplete, setIsComplete] = useState(false);

  const [currentMessage] = useState(
    ENCOURAGING_MESSAGES[Math.floor(Math.random() * ENCOURAGING_MESSAGES.length)]
  );

  // Auto-complete loading after max time
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!isComplete) {
        console.log('Loading timeout reached, completing...');
        setIsComplete(true);
        if (onLoadingComplete) {
          onLoadingComplete();
        }
      }
    }, maxLoadingTime);

    return () => clearTimeout(timeout);
  }, [maxLoadingTime, isComplete, onLoadingComplete]);

  useEffect(() => {
    const typewriter = (text: string, callback?: () => void) => {
      let i = 0;
      const timer = setInterval(() => {
        setDisplayedText(text.slice(0, i + 1));
        i++;
        if (i >= text.length) {
          clearInterval(timer);
          if (callback) {
            setTimeout(callback, 500);
          }
        }
      }, 50);
      return timer;
    };

    if (currentStep < LOADING_STEPS.length && !isComplete) {
      const step = LOADING_STEPS[currentStep];
      const timer = typewriter(step.text, () => {
        setTimeout(() => {
          if (currentStep === loadingSteps.length - 1) {
            // Last step completed
            setIsComplete(true);
            setTimeout(() => {
              if (onLoadingComplete) {
                onLoadingComplete();
              }
            }, 1000);
          } else {
            setCurrentStep(prev => prev + 1);
            setDisplayedText('');
          }
        }, step.delay);
      });

      return () => clearInterval(timer);
    }
  }, [currentStep, isComplete, onLoadingComplete]);

  // Cursor blinking effect
  useEffect(() => {
    const cursorTimer = setInterval(() => {
      setShowCursor(prev => !prev);
    }, 500);
    return () => clearInterval(cursorTimer);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center relative overflow-hidden">
      {/* Background Matrix Effect */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-full h-full bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48cGF0dGVybiBpZD0iZ3JpZCIgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBwYXR0ZXJuVW5pdHM9InVzZXJTcGFjZU9uVXNlIj48cGF0aCBkPSJNIDQwIDAgTCAwIDAgMCA0MCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDBmZjQxIiBzdHJva2Utd2lkdGg9IjEiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZ3JpZCkiLz48L3N2Zz4=')] animate-pulse"></div>
      </div>

      <div className="relative z-10 text-center max-w-2xl mx-auto p-8">
        {/* Retro Computer Header */}
        <div className="mb-8">
          <div className="bg-black border-2 border-green-400 rounded-lg p-4 font-mono text-green-400 shadow-lg shadow-green-400/20">
            <div className="flex items-center justify-between mb-2 text-xs">
              <span>CRYPTO-OS v2.1</span>
              <span>{new Date().toLocaleTimeString('he-IL')}</span>
            </div>
            <div className="border-t border-green-400 pt-2">
              <div className="text-lg font-bold mb-2 flex items-center justify-center gap-2">
                <Zap className="w-5 h-5" />
                מנוע החלטות קריפטו
              </div>
              <div className="text-sm opacity-80">מערכת ניתוח השקעות מתקדמת</div>
            </div>
          </div>
        </div>

        {/* Main Loading Display */}
        <div className="bg-black border-2 border-green-400 rounded-lg p-6 font-mono text-green-400 mb-6 shadow-lg shadow-green-400/20">
          <div className="flex items-center justify-center mb-4">
            <Loader2 className="w-8 h-8 animate-spin text-green-400 mr-3" />
            <span className="text-xl font-bold">מעבד נתונים...</span>
          </div>
          
          {/* Progress Bar */}
          <div className="w-full bg-gray-800 rounded-full h-2 mb-4">
            <div 
              className="bg-green-400 h-2 rounded-full transition-all duration-500 shadow-lg shadow-green-400/50"
              style={{ width: `${Math.min(((currentStep + 1) / loadingSteps.length) * 100, 100)}%` }}
            />
          </div>

          {/* Typewriter Text */}
          <div className="text-right h-6 mb-2">
            <span className="text-base">
              {displayedText}
              <span className={`ml-1 ${showCursor ? 'opacity-100' : 'opacity-0'} transition-opacity`}>
                █
              </span>
            </span>
          </div>

          {/* Step Counter */}
          <div className="text-xs opacity-60 mt-2">
            שלב {Math.min(currentStep + 1, loadingSteps.length)} מתוך {loadingSteps.length}
          </div>
        </div>

        {/* Encouraging Message */}
        <div className="bg-gradient-to-r from-blue-900/50 to-purple-900/50 border border-blue-400/30 rounded-lg p-4 mb-6">
          <div className="text-blue-200 text-lg font-semibold mb-2">
            💡 הודעה מעודדת
          </div>
          <div className="text-blue-100 animate-pulse">
            {currentMessage}
          </div>
        </div>

        {/* System Stats */}
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div className="bg-gray-900/50 border border-gray-600 rounded p-3">
            <div className="text-yellow-400 font-mono">CPU</div>
            <div className="text-yellow-200 animate-pulse">██████░░░░ 60%</div>
          </div>
          <div className="bg-gray-900/50 border border-gray-600 rounded p-3">
            <div className="text-cyan-400 font-mono">NET</div>
            <div className="text-cyan-200 animate-pulse">████████░░ 80%</div>
          </div>
          <div className="bg-gray-900/50 border border-gray-600 rounded p-3">
            <div className="text-green-400 font-mono">AI</div>
            <div className="text-green-200 animate-pulse">██████████ 100%</div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 text-xs text-gray-400 font-mono">
          <div className="animate-pulse">
            ▶ מערכת אבטחה: פעילה | הצפנה: RSA-2048 | חיבור: SSL
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoadingScreen;
