
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { 
  Shield, 
  TrendingDown, 
  Target, 
  Clock,
  AlertTriangle
} from 'lucide-react';
import { RiskManagementConfig } from '../services/advancedTradingService';

interface RiskManagementPanelProps {
  config: RiskManagementConfig;
  onConfigChange: (config: RiskManagementConfig) => void;
  onSave: () => void;
}

const RiskManagementPanel: React.FC<RiskManagementPanelProps> = ({ 
  config, 
  onConfigChange, 
  onSave 
}) => {
  const updateConfig = (field: keyof RiskManagementConfig, value: number | boolean) => {
    onConfigChange({
      ...config,
      [field]: value
    });
  };

  const getRiskLevel = () => {
    const riskScore = 
      config.maxDailyLoss * 0.3 + 
      config.maxPositionSize * 0.3 + 
      (100 - config.stopLossPercent * 10) * 0.2 + 
      (config.maxOpenPositions > 5 ? 20 : config.maxOpenPositions * 4) * 0.2;
    
    if (riskScore <= 20) return { level: 'נמוך', color: 'text-green-500', bg: 'bg-green-50' };
    if (riskScore <= 40) return { level: 'בינוני', color: 'text-yellow-500', bg: 'bg-yellow-50' };
    return { level: 'גבוה', color: 'text-red-500', bg: 'bg-red-50' };
  };

  const riskAssessment = getRiskLevel();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-mono">
          <Shield className="w-5 h-5" />
          ניהול סיכונים מתקדם
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Risk Level Indicator */}
        <div className={`p-3 rounded-lg ${riskAssessment.bg} border`}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm">רמת סיכון נוכחית:</span>
            <Badge className={`${riskAssessment.color} font-mono`}>
              {riskAssessment.level}
            </Badge>
          </div>
        </div>

        {/* Daily Loss Limit */}
        <div className="space-y-2">
          <Label className="font-mono flex items-center gap-2">
            <TrendingDown className="w-4 h-4" />
            מגבלת הפסד יומית (%): {config.maxDailyLoss}%
          </Label>
          <Slider
            value={[config.maxDailyLoss]}
            onValueChange={([value]) => updateConfig('maxDailyLoss', value)}
            max={20}
            min={1}
            step={0.5}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground font-mono">
            <span>1%</span>
            <span>20%</span>
          </div>
        </div>

        {/* Position Size */}
        <div className="space-y-2">
          <Label className="font-mono">
            גודל פוזיציה מקסימלי (%): {config.maxPositionSize}%
          </Label>
          <Slider
            value={[config.maxPositionSize]}
            onValueChange={([value]) => updateConfig('maxPositionSize', value)}
            max={25}
            min={1}
            step={0.5}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground font-mono">
            <span>1%</span>
            <span>25%</span>
          </div>
        </div>

        {/* Stop Loss */}
        <div className="space-y-2">
          <Label className="font-mono flex items-center gap-2">
            <Target className="w-4 h-4" />
            Stop Loss (%): {config.stopLossPercent}%
          </Label>
          <Slider
            value={[config.stopLossPercent]}
            onValueChange={([value]) => updateConfig('stopLossPercent', value)}
            max={10}
            min={0.5}
            step={0.1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground font-mono">
            <span>0.5%</span>
            <span>10%</span>
          </div>
        </div>

        {/* Take Profit */}
        <div className="space-y-2">
          <Label className="font-mono">
            Take Profit (%): {config.takeProfitPercent}%
          </Label>
          <Slider
            value={[config.takeProfitPercent]}
            onValueChange={([value]) => updateConfig('takeProfitPercent', value)}
            max={25}
            min={1}
            step={0.1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground font-mono">
            <span>1%</span>
            <span>25%</span>
          </div>
        </div>

        {/* Max Open Positions */}
        <div className="space-y-2">
          <Label className="font-mono">
            מספר פוזיציות מקסימלי: {config.maxOpenPositions}
          </Label>
          <Slider
            value={[config.maxOpenPositions]}
            onValueChange={([value]) => updateConfig('maxOpenPositions', value)}
            max={10}
            min={1}
            step={1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground font-mono">
            <span>1</span>
            <span>10</span>
          </div>
        </div>

        {/* Cooldown Period */}
        <div className="space-y-2">
          <Label htmlFor="cooldown" className="font-mono flex items-center gap-2">
            <Clock className="w-4 h-4" />
            תקופת המתנה (דקות)
          </Label>
          <Input
            id="cooldown"
            type="number"
            value={config.cooldownPeriod}
            onChange={(e) => updateConfig('cooldownPeriod', parseInt(e.target.value) || 0)}
            min={1}
            max={60}
            className="font-mono"
          />
        </div>

        {/* Advanced Features */}
        <div className="space-y-4 p-4 bg-muted/30 rounded-lg">
          <h3 className="font-mono font-semibold text-sm">תכונות מתקדמות</h3>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex items-center space-x-2 space-x-reverse">
              <Switch
                id="trailingStop"
                checked={config.trailingStopEnabled}
                onCheckedChange={(checked) => updateConfig('trailingStopEnabled', checked)}
              />
              <Label htmlFor="trailingStop" className="font-mono text-sm cursor-pointer">
                Trailing Stop Loss
              </Label>
            </div>

            <div className="flex items-center space-x-2 space-x-reverse">
              <Switch
                id="dynamicSizing"
                checked={config.dynamicPositionSizing}
                onCheckedChange={(checked) => updateConfig('dynamicPositionSizing', checked)}
              />
              <Label htmlFor="dynamicSizing" className="font-mono text-sm cursor-pointer">
                גודל פוזיציה דינמי
              </Label>
            </div>

            <div className="flex items-center space-x-2 space-x-reverse">
              <Switch
                id="rebalancing"
                checked={config.portfolioRebalancing}
                onCheckedChange={(checked) => updateConfig('portfolioRebalancing', checked)}
              />
              <Label htmlFor="rebalancing" className="font-mono text-sm cursor-pointer">
                איזון תיק אוטומטי
              </Label>
            </div>

            <div className="flex items-center space-x-2 space-x-reverse">
              <Switch
                id="sentiment"
                checked={config.sentimentAnalysis}
                onCheckedChange={(checked) => updateConfig('sentimentAnalysis', checked)}
              />
              <Label htmlFor="sentiment" className="font-mono text-sm cursor-pointer">
                ניתוח סנטימנט
              </Label>
            </div>

            <div className="flex items-center space-x-2 space-x-reverse">
              <Switch
                id="volume"
                checked={config.volumeAnalysis}
                onCheckedChange={(checked) => updateConfig('volumeAnalysis', checked)}
              />
              <Label htmlFor="volume" className="font-mono text-sm cursor-pointer">
                ניתוח נפח מסחר
              </Label>
            </div>

            <div className="flex items-center space-x-2 space-x-reverse">
              <Switch
                id="marketFilter"
                checked={config.marketConditionFilter}
                onCheckedChange={(checked) => updateConfig('marketConditionFilter', checked)}
              />
              <Label htmlFor="marketFilter" className="font-mono text-sm cursor-pointer">
                פילטר תנאי שוק
              </Label>
            </div>
          </div>

          {config.trailingStopEnabled && (
            <div className="space-y-2">
              <Label className="font-mono text-sm">
                Trailing Stop (%): {config.trailingStopPercent}%
              </Label>
              <Slider
                value={[config.trailingStopPercent]}
                onValueChange={([value]) => updateConfig('trailingStopPercent', value)}
                max={10}
                min={0.5}
                step={0.1}
                className="w-full"
              />
            </div>
          )}

          {config.sentimentAnalysis && (
            <div className="space-y-2">
              <Label className="font-mono text-sm">
                סף Fear & Greed: {config.fearGreedThreshold}
              </Label>
              <Slider
                value={[config.fearGreedThreshold]}
                onValueChange={([value]) => updateConfig('fearGreedThreshold', value)}
                max={100}
                min={0}
                step={5}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>פחד קיצוני (0)</span>
                <span>תאוות בצע קיצונית (100)</span>
              </div>
            </div>
          )}
        </div>

        {/* Warning for High Risk */}
        {riskAssessment.level === 'גבוה' && (
          <Alert className="border-red-200 bg-red-50">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <AlertDescription className="font-mono text-red-700">
              הגדרות הסיכון שלך גבוהות! שקול להקטין את גודל הפוזיציות או להגביר את Stop Loss.
            </AlertDescription>
          </Alert>
        )}

        <Button onClick={onSave} className="w-full font-mono" size="lg">
          <Shield className="w-4 h-4 mr-2" />
          שמור הגדרות סיכון
        </Button>
      </CardContent>
    </Card>
  );
};

export default RiskManagementPanel;
