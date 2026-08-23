
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  Plus, 
  Bot, 
  Bell, 
  User, 
  Palette,
  Zap,
  X
} from 'lucide-react';

interface FloatingActionMenuProps {
  onOpenChatbot: () => void;
  onOpenAlerts: () => void;
  onOpenDashboard: () => void;
  onOpenTheme: () => void;
}

const FloatingActionMenu = ({ 
  onOpenChatbot, 
  onOpenAlerts, 
  onOpenDashboard, 
  onOpenTheme 
}: FloatingActionMenuProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const menuItems = [
    {
      icon: Bot,
      label: 'צ\'אטבוט AI',
      color: 'text-blue-400 bg-blue-500/20 hover:bg-blue-500/30',
      onClick: () => {
        onOpenChatbot();
        setIsOpen(false);
      }
    },
    {
      icon: Bell,
      label: 'התראות',
      color: 'text-yellow-400 bg-yellow-500/20 hover:bg-yellow-500/30',
      onClick: () => {
        onOpenAlerts();
        setIsOpen(false);
      }
    },
    {
      icon: User,
      label: 'דשבורד אישי',
      color: 'text-green-400 bg-green-500/20 hover:bg-green-500/30',
      onClick: () => {
        onOpenDashboard();
        setIsOpen(false);
      }
    },
    {
      icon: Palette,
      label: 'נושא',
      color: 'text-purple-400 bg-purple-500/20 hover:bg-purple-500/30',
      onClick: () => {
        onOpenTheme();
        setIsOpen(false);
      }
    }
  ];

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {/* Menu Items */}
      {isOpen && (
        <div className="absolute bottom-16 right-0 flex flex-col gap-3 animate-scale-in">
          {menuItems.map((item, index) => (
            <div
              key={index}
              className="flex items-center gap-3 animate-fade-in"
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <div className="bg-background/95 backdrop-blur-xl px-3 py-2 rounded-lg border border-primary/30 text-sm text-yellow-300 whitespace-nowrap shadow-lg">
                {item.label}
              </div>
              <Button
                onClick={item.onClick}
                size="lg"
                className={`w-12 h-12 rounded-full shadow-xl transition-all duration-300 hover:scale-110 ${item.color} border border-primary/30`}
              >
                <item.icon className="w-5 h-5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Main Button */}
      <Button
        onClick={() => setIsOpen(!isOpen)}
        size="lg"
        className={`w-14 h-14 rounded-full shadow-2xl transition-all duration-300 hover:scale-110 ${
          isOpen 
            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 rotate-45' 
            : 'bg-primary/20 text-yellow-400 hover:bg-primary/30'
        } border border-primary/30`}
      >
        {isOpen ? <X className="w-6 h-6" /> : <Plus className="w-6 h-6" />}
      </Button>

      {/* Pulse effect */}
      {!isOpen && (
        <div className="absolute inset-0 w-14 h-14 rounded-full bg-primary/20 animate-ping pointer-events-none"></div>
      )}
    </div>
  );
};

export default FloatingActionMenu;
