<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Prompt Template Processor
 *
 * Processes template placeholders in prompts, replacing them with dynamic values.
 * Supports date/time, user context, workflow context, and custom variables.
 *
 * Template syntax: [placeholder_name] or [var:custom_name]
 *
 * Available placeholders:
 * - Date/Time: [date], [time], [datetime], [year], [month], [day], [weekday], [timezone]
 * - User: [username], [user_email], [user_id], [user_locale]
 * - Workflow: [workflow_name], [workflow_id], [agent_name], [node_name], [user_prompt]
 * - System: [app_name], [app_version]
 * - Custom: [var:name] for workflow-defined variables
 */
class PromptTemplateProcessor
{
    private array $context = [];
    private ?string $timezone = null;

    /**
     * Set the context for template processing
     *
     * @param array $context Associative array with context values
     */
    public function setContext(array $context): self
    {
        $this->context = array_merge($this->context, $context);
        return $this;
    }

    /**
     * Set timezone for date/time formatting
     */
    public function setTimezone(string $timezone): self
    {
        $this->timezone = $timezone;
        return $this;
    }

    /**
     * Process a prompt string, replacing all template placeholders
     *
     * @param string $prompt The prompt containing placeholders
     * @return string The processed prompt with replacements
     */
    public function process(string $prompt): string
    {
        // Match all [placeholder] patterns
        return preg_replace_callback(
            '/\[([a-zA-Z_][a-zA-Z0-9_:]*)\]/',
            fn($matches) => $this->replacePlaceholder($matches[1]),
            $prompt
        );
    }

    /**
     * Replace a single placeholder with its value
     */
    private function replacePlaceholder(string $placeholder): string
    {
        // Check for custom variables first (var:name syntax)
        if (str_starts_with($placeholder, 'var:')) {
            $varName = substr($placeholder, 4);
            return $this->getCustomVariable($varName);
        }

        // Built-in placeholders
        return match ($placeholder) {
            // Date/Time placeholders
            'date' => $this->formatDate('F j, Y'),           // April 7, 2026
            'time' => $this->formatDate('g:i A'),            // 3:45 PM
            'datetime' => $this->formatDate('F j, Y g:i A'), // April 7, 2026 3:45 PM
            'year' => $this->formatDate('Y'),                // 2026
            'month' => $this->formatDate('F'),               // April
            'month_num' => $this->formatDate('n'),           // 4
            'day' => $this->formatDate('j'),                 // 7
            'weekday' => $this->formatDate('l'),             // Monday
            'timezone' => $this->getTimezone(),
            'iso_date' => $this->formatDate('Y-m-d'),        // 2026-04-07
            'iso_datetime' => $this->formatDate('c'),        // ISO 8601 format

            // User placeholders
            'username' => $this->context['username'] ?? 'User',
            'user_email' => $this->context['user_email'] ?? '',
            'user_id' => (string)($this->context['user_id'] ?? ''),
            'user_locale' => $this->context['user_locale'] ?? 'en-US',

            // Workflow placeholders
            'workflow_name' => $this->context['workflow_name'] ?? '',
            'workflow_id' => (string)($this->context['workflow_id'] ?? ''),
            'agent_name' => $this->context['agent_name'] ?? '',
            'node_name' => $this->context['node_name'] ?? '',
            'node_id' => (string)($this->context['node_id'] ?? ''),
            'user_prompt' => $this->context['user_prompt'] ?? '',
            'previous_output' => $this->context['previous_output'] ?? '',

            // System placeholders
            'app_name' => $this->context['app_name'] ?? 'AI Assistant',
            'app_version' => $this->context['app_version'] ?? '1.0',

            // Unknown placeholder - return as-is
            default => "[{$placeholder}]",
        };
    }

    /**
     * Format current date/time
     */
    private function formatDate(string $format): string
    {
        $date = new \DateTime('now', $this->getTimezoneObject());
        return $date->format($format);
    }

    /**
     * Get timezone string
     */
    private function getTimezone(): string
    {
        return $this->timezone ?? date_default_timezone_get();
    }

    /**
     * Get DateTimeZone object
     */
    private function getTimezoneObject(): \DateTimeZone
    {
        try {
            return new \DateTimeZone($this->timezone ?? date_default_timezone_get());
        } catch (\Exception $e) {
            return new \DateTimeZone('UTC');
        }
    }

    /**
     * Get a custom variable value
     */
    private function getCustomVariable(string $name): string
    {
        // Check in custom_vars context
        $customVars = $this->context['custom_vars'] ?? [];
        if (isset($customVars[$name])) {
            return (string)$customVars[$name];
        }

        // Check in workflow_vars context (alternative location)
        $workflowVars = $this->context['workflow_vars'] ?? [];
        if (isset($workflowVars[$name])) {
            return (string)$workflowVars[$name];
        }

        // Return placeholder as-is if not found
        return "[var:{$name}]";
    }

    /**
     * Get list of all available placeholders with descriptions
     */
    public static function getAvailablePlaceholders(): array
    {
        return [
            'Date/Time' => [
                '[date]' => 'Current date (e.g., "April 7, 2026")',
                '[time]' => 'Current time (e.g., "3:45 PM")',
                '[datetime]' => 'Full date and time',
                '[year]' => 'Current year (e.g., "2026")',
                '[month]' => 'Current month name (e.g., "April")',
                '[month_num]' => 'Current month number (e.g., "4")',
                '[day]' => 'Day of month (e.g., "7")',
                '[weekday]' => 'Day of week (e.g., "Monday")',
                '[timezone]' => 'Current timezone',
                '[iso_date]' => 'ISO date format (YYYY-MM-DD)',
                '[iso_datetime]' => 'ISO 8601 datetime format',
            ],
            'User Context' => [
                '[username]' => 'Current user\'s name',
                '[user_email]' => 'User\'s email address',
                '[user_id]' => 'User\'s ID',
                '[user_locale]' => 'User\'s locale (e.g., "en-US")',
            ],
            'Workflow Context' => [
                '[workflow_name]' => 'Name of current workflow',
                '[workflow_id]' => 'ID of current workflow',
                '[agent_name]' => 'This agent\'s name',
                '[node_name]' => 'Current node name',
                '[node_id]' => 'Current node ID',
                '[user_prompt]' => 'Original user input/prompt',
                '[previous_output]' => 'Output from previous node',
            ],
            'System' => [
                '[app_name]' => 'Application name',
                '[app_version]' => 'Application version',
            ],
            'Custom Variables' => [
                '[var:name]' => 'Custom workflow variable (replace "name" with variable name)',
            ],
        ];
    }

    /**
     * Check if a string contains any template placeholders
     */
    public static function hasPlaceholders(string $text): bool
    {
        return (bool)preg_match('/\[[a-zA-Z_][a-zA-Z0-9_:]*\]/', $text);
    }
}
