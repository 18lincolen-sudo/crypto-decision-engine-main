
import React from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SimulationBotProvider } from "./contexts/SimulationBotContext";
import { LegacySimulationBotProvider } from "./contexts/LegacySimulationBotContext";
import ErrorBoundary from "./components/ErrorBoundary";
import Index from "./pages/Index";
import Portfolio from "./pages/Portfolio";
import Alerts from "./pages/Alerts";
import SimulationBot from "./pages/SimulationBot";
import RealTradingBot from "./pages/RealTradingBot";
import AdvancedAnalysis from "./pages/AdvancedAnalysis";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 3,
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes
    },
  },
});

const App = () => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <SimulationBotProvider>
              <LegacySimulationBotProvider>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/portfolio" element={<Portfolio />} />
                <Route path="/alerts" element={<Alerts />} />
                <Route path="/simulation-bot" element={<SimulationBot />} />
                <Route path="/real-trading" element={<RealTradingBot />} />
                <Route path="/real-trading-bot" element={<RealTradingBot />} />
                <Route path="/advanced-analysis" element={<AdvancedAnalysis />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
              </LegacySimulationBotProvider>
              </SimulationBotProvider>
            </BrowserRouter>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
