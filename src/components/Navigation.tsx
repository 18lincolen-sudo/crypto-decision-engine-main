
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from './ui/button';
import { ThemeToggle } from './ThemeToggle';
import { 
  BarChart3, 
  Bell, 
  Briefcase, 
  Bot, 
  TrendingUp, 
  Menu, 
  X,
  Shield
} from 'lucide-react';

const Navigation = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems = [
    { to: '/', icon: BarChart3, label: 'בית', color: 'text-green-400' },
    { to: '/simulation-bot', icon: Bot, label: 'בוט סימולציה', color: 'text-purple-400' },
    { to: '/real-trading', icon: Shield, label: 'בוט מסחר אמיתי', color: 'text-red-400' },
    { to: '/portfolio', icon: Briefcase, label: 'תיק השקעות', color: 'text-blue-400' },
    { to: '/advanced-analysis', icon: TrendingUp, label: 'ניתוח מתקדם', color: 'text-cyan-400' },
    { to: '/alerts', icon: Bell, label: 'התראות והגדרות', color: 'text-yellow-400' },
  ];

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  return (
    <nav className="bg-card border-b border-border sticky top-0 z-50 backdrop-blur-md bg-opacity-90">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center space-x-2 space-x-reverse">
            <div className="w-8 h-8 bg-gradient-to-br from-green-400 to-blue-500 rounded-lg flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold font-mono text-foreground hidden sm:block">
              🚀 CryptoBot AI
            </span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-4 space-x-reverse">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="flex items-center space-x-2 space-x-reverse px-3 py-2 rounded-md text-sm font-medium font-mono transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <item.icon className={`w-4 h-4 ${item.color}`} />
                <span className="text-foreground">{item.label}</span>
              </Link>
            ))}
            <ThemeToggle />
          </div>

          {/* Mobile menu button */}
          <div className="md:hidden flex items-center space-x-2 space-x-reverse">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleMobileMenu}
              className="p-2"
            >
              {isMobileMenuOpen ? (
                <X className="w-5 h-5" />
              ) : (
                <Menu className="w-5 h-5" />
              )}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {isMobileMenuOpen && (
          <div className="md:hidden border-t border-border bg-card/95 backdrop-blur-md">
            <div className="px-2 pt-2 pb-3 space-y-1">
              {navItems.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="flex items-center space-x-3 space-x-reverse px-3 py-3 rounded-md text-base font-medium font-mono transition-colors hover:bg-accent hover:text-accent-foreground block"
                >
                  <item.icon className={`w-5 h-5 ${item.color}`} />
                  <span className="text-foreground">{item.label}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
};

export default Navigation;
