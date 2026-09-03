
import { useState } from 'react';
import { useCryptoData } from '../hooks/useCryptoData';
import { usePortfolio } from '../hooks/usePortfolio';
import { useTheme } from '../contexts/ThemeContext';
import Navigation from '../components/Navigation';
import PortfolioOverview from '../components/PortfolioOverview';
import PortfolioBuilder from '../components/PortfolioBuilder';
import PortfolioChart from '../components/PortfolioChart';
import PortfolioHeader from '../components/portfolio/PortfolioHeader';
import PortfolioHoldings from '../components/portfolio/PortfolioHoldings';
import EmptyPortfolio from '../components/portfolio/EmptyPortfolio';
import CryptoDetailModal from '../components/CryptoDetailModal';
import CryptoChart from '../components/CryptoChart';
import PersonalizedDashboard from '../components/PersonalizedDashboard';
import AIChatbot from '../components/AIChatbot';
import AlertsPanel from '../components/AlertsPanel';
import FloatingActionMenu from '../components/FloatingActionMenu';
import ParticleBackground from '../components/ParticleBackground';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, AlertCircle } from 'lucide-react';
import { CryptoRecommendation } from '@cde/engine';

const Portfolio = () => {
  const { cryptoData, recommendations, isLoading, error } = useCryptoData();
  const { portfolio, calculatePortfolioAnalysis } = usePortfolio();
  const { actualTheme, setTheme } = useTheme();
  const toggleTheme = () => setTheme(actualTheme === 'dark' ? 'light' : 'dark');
  const [showPortfolioBuilder, setShowPortfolioBuilder] = useState(false);
  const [selectedCrypto, setSelectedCrypto] = useState<CryptoRecommendation | null>(null);
  const [selectedCryptoChart, setSelectedCryptoChart] = useState<string | null>(null);
  
  // New feature states
  const [showChatbot, setShowChatbot] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showPersonalDashboard, setShowPersonalDashboard] = useState(false);
  const [activeTab, setActiveTab] = useState('portfolio');

  const portfolioAnalysis = calculatePortfolioAnalysis(recommendations);
  const hasPortfolioItems = portfolio?.items && portfolio.items.length > 0;

  if (error) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <ParticleBackground />
        <div className="flex items-center justify-center p-4 pt-20">
          <Card className="w-full max-w-md">
            <CardContent className="flex items-center justify-center p-6">
              <div className="text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">שגיאה בטעינת הנתונים</h2>
                <p className="text-muted-foreground">
                  אנא נסה לרענן את הדף או בדוק את החיבור לאינטרנט
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <ParticleBackground />
        <div className="flex items-center justify-center pt-20">
          <div className="text-center">
            <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">טוען נתוני תיק...</h2>
            <p className="text-muted-foreground">
              מעדכן נתוני השקעות ומחשב ביצועים
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background relative">
      <Navigation />
      <ParticleBackground />
      
      <div className="max-w-7xl mx-auto p-4 relative z-10">
        <div className="flex items-center justify-between mb-6">
          <PortfolioHeader 
            showPortfolioBuilder={showPortfolioBuilder}
            onToggleBuilder={() => setShowPortfolioBuilder(!showPortfolioBuilder)}
          />
        </div>

        {/* Enhanced Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-8 bg-background/50 backdrop-blur-xl border border-primary/30">
            <TabsTrigger 
              value="portfolio" 
              className="data-[state=active]:bg-primary/30 data-[state=active]:text-yellow-400 text-yellow-300"
            >
              ניהול תיק
            </TabsTrigger>
            <TabsTrigger 
              value="dashboard" 
              className="data-[state=active]:bg-primary/30 data-[state=active]:text-yellow-400 text-yellow-300"
            >
              דשבורד אישי
            </TabsTrigger>
          </TabsList>

          <TabsContent value="portfolio" className="space-y-8">
            {/* Portfolio Management */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Portfolio Overview */}
              <div className="lg:col-span-2">
                <PortfolioOverview analysis={portfolioAnalysis} />
              </div>
              
              {/* Portfolio Builder */}
              {showPortfolioBuilder && (
                <div>
                  <PortfolioBuilder 
                    availableCryptos={cryptoData || []}
                    onClose={() => setShowPortfolioBuilder(false)}
                  />
                </div>
              )}
            </div>

            {/* Portfolio Chart */}
            {portfolioAnalysis && (
              <div>
                <PortfolioChart analysis={portfolioAnalysis} />
              </div>
            )}

            {/* Portfolio Holdings or Empty State */}
            {hasPortfolioItems ? (
              <PortfolioHoldings 
                portfolioAnalysis={portfolioAnalysis}
                recommendations={recommendations}
                cryptoData={cryptoData}
                onSelectCrypto={setSelectedCrypto}
                onSelectChart={setSelectedCryptoChart}
              />
            ) : (
              <EmptyPortfolio onStartBuilding={() => setShowPortfolioBuilder(true)} />
            )}
          </TabsContent>

          <TabsContent value="dashboard">
            <PersonalizedDashboard />
          </TabsContent>
        </Tabs>

        {/* Modals */}
        <CryptoDetailModal 
          crypto={selectedCrypto}
          isOpen={!!selectedCrypto}
          onClose={() => setSelectedCrypto(null)}
        />

        <CryptoChart
          symbol={selectedCryptoChart}
          isOpen={!!selectedCryptoChart}
          onClose={() => setSelectedCryptoChart(null)}
        />

        {/* Enhanced Features */}
        <AIChatbot 
          isOpen={showChatbot}
          onClose={() => setShowChatbot(false)}
        />

        <AlertsPanel 
          isOpen={showAlerts}
          onClose={() => setShowAlerts(false)}
        />

        <FloatingActionMenu
          onOpenChatbot={() => setShowChatbot(true)}
          onOpenAlerts={() => setShowAlerts(true)}
          onOpenDashboard={() => setShowPersonalDashboard(true)}
          onOpenTheme={toggleTheme}
        />
      </div>
    </div>
  );
};

export default Portfolio;
