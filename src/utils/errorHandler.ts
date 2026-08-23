
export class AppError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NetworkError extends AppError {
  constructor(message: string = 'שגיאת רשת') {
    super(message, 'NETWORK_ERROR', 0);
  }
}

export class APIError extends AppError {
  constructor(message: string, statusCode?: number) {
    super(message, 'API_ERROR', statusCode);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export const handleError = (error: unknown): string => {
  console.error('Error occurred:', error);

  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error) {
    // Handle specific error types
    if (error.message.includes('fetch')) {
      return 'שגיאת חיבור לשרת. אנא בדוק את החיבור לאינטרנט.';
    }
    
    if (error.message.includes('timeout')) {
      return 'החיבור לשרת פג. אנא נסה שוב.';
    }

    if (error.message.includes('401')) {
      return 'שגיאת הרשאה. אנא בדוק את פרטי ה-API.';
    }

    if (error.message.includes('429')) {
      return 'יותר מדי בקשות. אנא המתן מספר דקות ונסה שוב.';
    }

    return error.message;
  }

  return 'אירעה שגיאה לא צפויה. אנא נסה שוב.';
};

export const withErrorHandling = <T extends (...args: any[]) => Promise<any>>(
  fn: T
): T => {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      const errorMessage = handleError(error);
      throw new AppError(errorMessage);
    }
  }) as T;
};
