
import React from 'react';
import { Helmet } from 'react-helmet-async';

interface SEOHeadProps {
  title?: string;
  description?: string;
  keywords?: string[];
  image?: string;
  url?: string;
}

const SEOHead: React.FC<SEOHeadProps> = ({
  title = 'בוט מסחר של מנחם - בוט מסחר חכם לקריפטו',
  description = 'בוט מסחר חכם לקריפטו עם בינה מלאכותית, ניתוח טכני מתקדם ומסחר אוטומטי. השקעה חכמה ובטוחה בשוק הקריפטו.',
  keywords = ['קריפטו', 'בוט מסחר', 'בינה מלאכותית', 'ביטקוין', 'אתריום', 'מסחר אוטומטי'],
  image = '/placeholder.svg',
  url = typeof window !== 'undefined' ? window.location.origin : 'https://crypto-d.netlify.app'
}) => {
  const fullTitle = title.includes('בוט מסחר של מנחם') ? title : `${title} | בוט מסחר של מנחם`;
  
  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta name="keywords" content={keywords.join(', ')} />
      <meta name="author" content="בוט מסחר של מנחם" />
      <meta name="robots" content="index, follow" />
      <meta name="language" content="he" />
      <meta name="direction" content="rtl" />
      
      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={image} />
      <meta property="og:url" content={url} />
      <meta property="og:site_name" content="בוט מסחר של מנחם" />
      <meta property="og:locale" content="he_IL" />
      
      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
      
      {/* PWA */}
      <meta name="theme-color" content="#22c55e" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      <meta name="apple-mobile-web-app-title" content="בוט מסחר של מנחם" />
      
      {/* Favicon */}
      <link rel="icon" type="image/svg+xml" href="/favicon.ico" />
      <link rel="apple-touch-icon" href="/placeholder.svg" />
      
      {/* Canonical URL */}
      <link rel="canonical" href={url} />
    </Helmet>
  );
};

export default SEOHead;
