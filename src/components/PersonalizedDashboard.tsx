
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  User, 
  TrendingUp, 
  TrendingDown, 
  Target, 
  Calendar,
  Star,
  Award,
  Zap,
  Settings
} from 'lucide-react';

interface UserStats {
  totalProfit: number;
  totalInvestment: number;
  winRate: number;
  activePositions: number;
  daysSinceStart: number;
  favoriteSymbol: string;
  riskLevel: 'low' | 'medium' | 'high';
  achievements: string[];
}

const PersonalizedDashboard = () => {
  const [userStats, setUserStats] = useState<UserStats>({
    totalProfit: 2547.80,
    totalInvestment: 15000,
    winRate: 73.5,
    activePositions: 8,
    daysSinceStart: 127,
    favoriteSymbol: 'BTC',
    riskLevel: 'medium',
    achievements: ['First Trade', 'Profitable Week', 'Diamond Hands', 'Risk Manager']
  });

  const [greeting, setGreeting] = useState('');

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreeting('בוקר טוב');
    else if (hour < 18) setGreeting('צהריים טובים');
    else setGreeting('ערב טוב');
  }, []);

  const profitPercentage = (userStats.totalProfit / userStats.totalInvestment) * 100;
  const riskLevelColor = {
    low: 'text-green-400 bg-green-500/20',
    medium: 'text-yellow-400 bg-yellow-500/20',
    high: 'text-red-400 bg-red-500/20'
  };

  const riskLevelText = {
    low: 'שמרני',
    medium: 'מאוזן',
    high: 'אגרסיבי'
  };

  return (
    <div className="space-y-6">
      {/* Welcome Section */}
      <Card className="bg-gradient-to-r from-background/95 to-background/80 backdrop-blur-xl border-primary/30">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-gradient-to-br from-yellow-400 via-primary to-green-400 rounded-full flex items-center justify-center shadow-lg">
                <User className="w-8 h-8 text-black" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-yellow-400 mb-1">
                  {greeting}, משקיע פרו! 🚀
                </h2>
                <p className="text-yellow-300/80">
                  אתה משקיע כבר {userStats.daysSinceStart} ימים והכל נראה מעולה
                </p>
              </div>
            </div>
            
            <Button
              variant="ghost"
              size="sm"
              className="text-yellow-300 hover:text-yellow-200 hover:bg-primary/20"
            >
              <Settings className="w-4 h-4 mr-2" />
              הגדרות
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-background/95 backdrop-blur-xl border-primary/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">רווח כולל</p>
                <p className={`text-2xl font-bold ${userStats.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {userStats.totalProfit >= 0 ? '+' : ''}${userStats.totalProfit.toFixed(2)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {profitPercentage >= 0 ? '+' : ''}{profitPercentage.toFixed(1)}%
                </p>
              </div>
              {userStats.totalProfit >= 0 ? 
                <TrendingUp className="w-8 h-8 text-green-400" /> : 
                <TrendingDown className="w-8 h-8 text-red-400" />
              }
            </div>
          </CardContent>
        </Card>

        <Card className="bg-background/95 backdrop-blur-xl border-primary/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">אחוז הצלחה</p>
                <p className="text-2xl font-bold text-yellow-400">
                  {userStats.winRate}%
                </p>
                <Progress value={userStats.winRate} className="w-full mt-2 h-2" />
              </div>
              <Target className="w-8 h-8 text-yellow-400" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-background/95 backdrop-blur-xl border-primary/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">פוזיציות פעילות</p>
                <p className="text-2xl font-bold text-blue-400">
                  {userStats.activePositions}
                </p>
                <p className="text-xs text-muted-foreground">
                  מטבע מועדף: {userStats.favoriteSymbol}
                </p>
              </div>
              <Zap className="w-8 h-8 text-blue-400" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-background/95 backdrop-blur-xl border-primary/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">פרופיל סיכון</p>
                <Badge className={`${riskLevelColor[userStats.riskLevel]} mb-2`}>
                  {riskLevelText[userStats.riskLevel]}
                </Badge>
                <p className="text-xs text-muted-foreground">
                  מותאם לך אישית
                </p>
              </div>
              <Calendar className="w-8 h-8 text-purple-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Achievements */}
      <Card className="bg-background/95 backdrop-blur-xl border-primary/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-yellow-400">
            <Award className="w-5 h-5" />
            ההישגים שלך
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {userStats.achievements.map((achievement, index) => (
              <div
                key={index}
                className="flex items-center gap-2 p-3 bg-gradient-to-r from-primary/10 to-primary/5 rounded-lg border border-primary/20 hover:border-primary/40 transition-all duration-300"
              >
                <Star className="w-4 h-4 text-yellow-400" />
                <span className="text-sm text-foreground">{achievement}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card className="bg-background/95 backdrop-blur-xl border-primary/30">
        <CardHeader>
          <CardTitle className="text-yellow-400">פעולות מהירות</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Button className="h-auto p-4 flex flex-col gap-2 bg-primary/20 hover:bg-primary/30 border border-primary/30">
              <TrendingUp className="w-6 h-6" />
              <span className="text-sm">עדכן תיק</span>
            </Button>
            <Button className="h-auto p-4 flex flex-col gap-2 bg-primary/20 hover:bg-primary/30 border border-primary/30">
              <Target className="w-6 h-6" />
              <span className="text-sm">הגדר יעד</span>
            </Button>
            <Button className="h-auto p-4 flex flex-col gap-2 bg-primary/20 hover:bg-primary/30 border border-primary/30">
              <Zap className="w-6 h-6" />
              <span className="text-sm">סריקה מהירה</span>
            </Button>
            <Button className="h-auto p-4 flex flex-col gap-2 bg-primary/20 hover:bg-primary/30 border border-primary/30">
              <Award className="w-6 h-6" />
              <span className="text-sm">אתגרים</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default PersonalizedDashboard;
