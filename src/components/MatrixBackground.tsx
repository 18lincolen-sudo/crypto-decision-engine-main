
import { CSSProperties } from 'react';

interface MatrixBackgroundProps {
  count?: number;
  chars?: string[];
  className?: string;
}

// Shared animated background used by the Alerts and Advanced Analysis pages.
// Renders floating characters (real DOM, no canvas) behind page content.
export const MatrixBackground = ({
  count = 20,
  chars = ['1', '0'],
  className = ''
}: MatrixBackgroundProps) => {
  return (
    <div className={`matrix-bg ${className}`} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => {
        const style: CSSProperties = {
          left: `${Math.random() * 100}%`,
          animationDelay: `${Math.random() * 8}s`,
          animationDuration: `${8 + Math.random() * 4}s`
        };
        const char = chars[Math.floor(Math.random() * chars.length)];
        return (
          <div key={i} className="matrix-char" style={style}>
            {char}
          </div>
        );
      })}
    </div>
  );
};

export default MatrixBackground;
