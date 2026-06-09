<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Exceptions;

/**
 * Exception for function execution errors
 */
class FunctionExecutionException extends AIAssistantException
{
    private ?string $functionName = null;

    public function setFunctionName(string $name): self
    {
        $this->functionName = $name;
        return $this;
    }

    public function getFunctionName(): ?string
    {
        return $this->functionName;
    }

    /**
     * Create exception for function not found
     */
    public static function notFound(string $functionName): self
    {
        $exception = new self("Function '{$functionName}' is not registered.", 404);
        $exception->setFunctionName($functionName);
        return $exception;
    }

    /**
     * Create exception for execution failure
     */
    public static function executionFailed(string $functionName, string $reason): self
    {
        $exception = new self("Function '{$functionName}' execution failed: {$reason}", 500);
        $exception->setFunctionName($functionName);
        return $exception;
    }

    /**
     * Create exception for invalid parameters
     */
    public static function invalidParameters(string $functionName, string $details): self
    {
        $exception = new self("Invalid parameters for function '{$functionName}': {$details}", 400);
        $exception->setFunctionName($functionName);
        return $exception;
    }
}
