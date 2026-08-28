
import { useState, useRef, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Bot, Send, X, Minimize2, Maximize2, Volume2, VolumeX } from 'lucide-react';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
  typing?: boolean;
}

interface AIChatbotProps {
  isOpen: boolean;
  onClose: () => void;
}

const AIChatbot = ({ isOpen, onClose }: AIChatbotProps) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      text: 'שלום! אני עוזר AI לקריפטו. איך אני יכול לעזור לך היום?',
      sender: 'ai',
      timestamp: new Date()
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isMinimized, setIsMinimized] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const playMessageSound = () => {
    if (!soundEnabled) return;
    if (typeof window === 'undefined') return;
    
    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  };

  const generateAIResponse = (userMessage: string): string => {
    const responses = {
      'מחיר': 'המחירים משתנים בזמן אמת. אני ממליץ לבדוק את הגרפים המתקדמים שלנו לניתוח מדויק יותר.',
      'ביטקוין': 'ביטקוין הוא המטבע הדיגיטלי הראשון והגדול ביותר. יש לו פוטנציאל גדול אבל גם תנודתי.',
      'אתריום': 'אתריום הוא פלטפורמה מתקדמת לחוזים חכמים. ETH הוא המטבע השני בגודלו.',
      'השקעה': 'השקעה בקריפטו דורשת מחקר יסודי. אל תשקיע יותר ממה שאתה יכול להרשות לעצמך להפסיד.',
      'ניתוח': 'המערכת שלנו מספקת ניתוח טכני מתקדם. בדוק את דף הניתוח המתקדם לפרטים נוספים.',
      'תיק': 'ניהול תיק טוב דורש גיוון. השתמש בכלי בניית התיק שלנו לאופטימיזציה.',
      'התראות': 'ההתראות שלנו יעזרו לך לא לפספס הזדמנויות. אפשר להגדיר התראות מותאמות אישית.'
    };

    for (const [keyword, response] of Object.entries(responses)) {
      if (userMessage.includes(keyword)) {
        return response;
      }
    }

    const defaultResponses = [
      'זה שאלה מעניינת! אני ממליץ לבדוק את הנתונים המתקדמים באפליקציה.',
      'על פי הניתוח שלי, כדאי לבחון את המגמות הארוכות טווח.',
      'השוק תמיד מלא באתגרים והזדמנויות. חשוב להיות מעודכן.',
      'המלצה שלי: תמיד עשה מחקר עצמאי לפני קבלת החלטות.',
      'הנתונים שלנו מתעדכנים בזמן אמת כדי לעזור לך לקבל החלטות מושכלות.'
    ];

    return defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
  };

  const handleSendMessage = async () => {
    if (!inputText.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputText,
      sender: 'user',
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');

    // Show typing indicator
    const typingMessage: Message = {
      id: 'typing',
      text: 'כותב...',
      sender: 'ai',
      timestamp: new Date(),
      typing: true
    };

    setMessages(prev => [...prev, typingMessage]);

    // Simulate AI thinking time
    setTimeout(() => {
      const response = generateAIResponse(userMessage.text);
      const aiMessage: Message = {
        id: Date.now().toString(),
        text: response,
        sender: 'ai',
        timestamp: new Date()
      };

      setMessages(prev => prev.filter(msg => msg.id !== 'typing').concat(aiMessage));
      playMessageSound();
    }, Math.random() * 2000 + 1000);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 animate-scale-in">
      <Card className={`bg-background/95 backdrop-blur-xl border border-primary/30 shadow-2xl transition-all duration-300 ${isMinimized ? 'w-72 h-16' : 'w-96 h-[500px]'}`}>
        <CardHeader className="p-3 border-b border-primary/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-br from-yellow-400 via-primary to-green-400 rounded-full flex items-center justify-center">
                <Bot className="w-4 h-4 text-black" />
              </div>
              <div>
                <CardTitle className="text-sm text-yellow-400">עוזר AI</CardTitle>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                  <span className="text-xs text-yellow-300/80">מחובר</span>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSoundEnabled(!soundEnabled)}
                className="w-8 h-8 p-0 text-yellow-300 hover:text-yellow-200 hover:bg-primary/20"
              >
                {soundEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsMinimized(!isMinimized)}
                className="w-8 h-8 p-0 text-yellow-300 hover:text-yellow-200 hover:bg-primary/20"
              >
                {isMinimized ? <Maximize2 className="w-3 h-3" /> : <Minimize2 className="w-3 h-3" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="w-8 h-8 p-0 text-yellow-300 hover:text-yellow-200 hover:bg-primary/20"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </CardHeader>

        {!isMinimized && (
          <CardContent className="p-0 flex flex-col h-[calc(500px-80px)]">
            <ScrollArea className="flex-1 p-4">
              <div className="space-y-3">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] p-3 rounded-lg text-sm ${
                        message.sender === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground'
                      } ${message.typing ? 'animate-pulse' : ''}`}
                    >
                      {message.text}
                      <div className="text-xs opacity-70 mt-1">
                        {message.timestamp.toLocaleTimeString('he-IL', { 
                          hour: '2-digit', 
                          minute: '2-digit' 
                        })}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            <div className="p-4 border-t border-primary/20">
              <div className="flex gap-2">
                <Input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="שאל אותי על קריפטו..."
                  className="flex-1 bg-background/50 border-primary/30 text-foreground placeholder:text-muted-foreground"
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={!inputText.trim()}
                  className="px-3 bg-primary hover:bg-primary/80 text-primary-foreground"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              
              <div className="flex gap-1 mt-2 flex-wrap">
                {['מחיר ביטקוין', 'ניתוח שוק', 'איך להשקיע', 'תיק מומלץ'].map((suggestion, index) => (
                  <Badge
                    key={index}
                    variant="outline"
                    className="text-xs cursor-pointer hover:bg-primary/20 border-primary/30 text-yellow-300 hover:text-yellow-200"
                    onClick={() => setInputText(suggestion)}
                  >
                    {suggestion}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
};

export default AIChatbot;
