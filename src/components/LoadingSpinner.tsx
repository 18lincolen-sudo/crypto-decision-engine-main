
import React from 'react';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
}

const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ 
  size = 'md', 
  text = 'טוען...' 
}) => {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12'
  };

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base'
  };

  return (
    <div className="flex flex-col items-center justify-center gap-2 p-4">
      <div className={`${sizeClasses[size]} animate-spin rounded-full border-2 border-primary border-t-transparent`} />
      {text && (
        <p className={`${textSizeClasses[size]} text-muted-foreground font-mono`}>
          {text}
        </p>
      )}
    </div>
  );
};

export default LoadingSpinner;
