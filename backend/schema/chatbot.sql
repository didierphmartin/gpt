-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: localhost:3306
-- Generation Time: Jun 08, 2026 at 08:19 PM
-- Server version: 8.4.8-cll-lve
-- PHP Version: 8.4.21

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `netfo587_chatbot`
--
CREATE DATABASE IF NOT EXISTS `netfo587_chatbot` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE `netfo587_chatbot`;

-- --------------------------------------------------------

--
-- Table structure for table `affiliates`
--

CREATE TABLE `affiliates` (
  `id` bigint NOT NULL,
  `user_id` bigint NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `affiliate_key` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `affiliate_accounts`
--

CREATE TABLE `affiliate_accounts` (
  `id` bigint NOT NULL,
  `affiliate_id` bigint NOT NULL,
  `product_id` bigint NOT NULL,
  `commission_type` enum('percent','fixed') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `commission_value` decimal(12,2) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `affiliate_products`
--

CREATE TABLE `affiliate_products` (
  `id` bigint NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_ref` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sales_page_url` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `commission_type` enum('percent','fixed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'percent',
  `commission_value` decimal(12,2) NOT NULL DEFAULT '0.00',
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'USD',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `affiliate_sales`
--

CREATE TABLE `affiliate_sales` (
  `id` bigint NOT NULL,
  `affiliate_id` bigint NOT NULL,
  `product_id` bigint NOT NULL,
  `sale_amount` decimal(12,2) NOT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'USD',
  `commission_amount` decimal(12,2) NOT NULL,
  `status` enum('pending','paid') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `external_ref` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `occurred_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `paid_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `agents`
--

CREATE TABLE `agents` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `team_id` int DEFAULT NULL,
  `category` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `agent_type` enum('standard','manager','worker') COLLATE utf8mb4_unicode_ci DEFAULT 'standard',
  `parent_agent_id` int DEFAULT NULL,
  `can_delegate_to` json DEFAULT NULL,
  `display_order` int NOT NULL DEFAULT '0',
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT 'claude',
  `model` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `instructions` text COLLATE utf8mb4_unicode_ci,
  `tools` json DEFAULT NULL,
  `visibility` enum('personal','workspace','public') COLLATE utf8mb4_unicode_ci DEFAULT 'personal',
  `enabled` tinyint(1) DEFAULT '1',
  `settings` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `agent_conversations`
--

CREATE TABLE `agent_conversations` (
  `id` int NOT NULL,
  `agent_id` int NOT NULL,
  `user_id` int NOT NULL,
  `context_id` int DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `message_count` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `agent_executions`
--

CREATE TABLE `agent_executions` (
  `id` int NOT NULL,
  `parent_execution_id` int DEFAULT NULL,
  `agent_id` int NOT NULL,
  `user_id` int NOT NULL,
  `input` text COLLATE utf8mb4_unicode_ci,
  `output` longtext COLLATE utf8mb4_unicode_ci,
  `status` enum('pending','running','completed','failed') COLLATE utf8mb4_unicode_ci DEFAULT 'pending',
  `error_message` text COLLATE utf8mb4_unicode_ci,
  `tokens_used` int DEFAULT '0',
  `prompt_tokens` int DEFAULT '0',
  `completion_tokens` int DEFAULT '0',
  `cost_usd` decimal(10,6) DEFAULT '0.000000',
  `response_time_ms` int DEFAULT '0',
  `tools_called` json DEFAULT NULL,
  `started_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` timestamp NULL DEFAULT NULL,
  `metadata` json DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `agent_teams`
--

CREATE TABLE `agent_teams` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `workspace_id` int DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `agent_workflows`
--

CREATE TABLE `agent_workflows` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `workspace_id` int DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `steps` json NOT NULL,
  `triggers` json DEFAULT NULL,
  `variables` json DEFAULT NULL,
  `enabled` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `output_storage_enabled` tinyint(1) DEFAULT '0',
  `output_folder` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `agent_workflow_executions`
--

CREATE TABLE `agent_workflow_executions` (
  `id` int NOT NULL,
  `workflow_id` int NOT NULL,
  `user_id` int NOT NULL,
  `input_variables` json DEFAULT NULL,
  `output` json DEFAULT NULL,
  `status` enum('pending','running','completed','failed') DEFAULT 'pending',
  `error_message` text,
  `response_time_ms` int DEFAULT '0',
  `started_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` timestamp NULL DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `app_keys`
--

CREATE TABLE `app_keys` (
  `id` int NOT NULL,
  `user_id` int NOT NULL COMMENT 'User the key operates on behalf of; middleware sets $request[user_id]\r\n   from this',
  `application_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Free identifier for the application (slug, UUID, etc.)',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Human label for this specific key',
  `key_prefix` char(12) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'First 12 chars of the key (ak_xxxxxxxx); indexed, not secret',
  `key_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Hex HMAC-SHA256(server_secret, full_key)',
  `scopes` json NOT NULL COMMENT 'e.g. ["workflows:run:42"]; mint rejects empty',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `chat_attachments`
--

CREATE TABLE `chat_attachments` (
  `id` bigint NOT NULL,
  `user_id` bigint NOT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `stored_path` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime_type` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `size_bytes` bigint NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `conversation_contexts`
--

CREATE TABLE `conversation_contexts` (
  `id` int NOT NULL,
  `user_id` int NOT NULL DEFAULT '1',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `context_data` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Primary provider used in this context',
  `message_count` int NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `exchange_rates`
--

CREATE TABLE `exchange_rates` (
  `currency` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL,
  `rate` decimal(10,6) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `hume_tool_mapping`
--

CREATE TABLE `hume_tool_mapping` (
  `id` int NOT NULL,
  `tool_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Backend function name (e.g., get_user_watchlist)',
  `hume_tool_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Hume API tool ID (UUID format)',
  `hume_version` int DEFAULT '1' COMMENT 'Tool version in Hume',
  `definition_hash` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'MD5 hash of tool definition for change detection',
  `last_synced` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last sync timestamp',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Record creation time'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Caches mapping between backend functions and Hume EVI tool IDs to optimize sync performance';

-- --------------------------------------------------------

--
-- Table structure for table `llm_usage_balance`
--

CREATE TABLE `llm_usage_balance` (
  `user_id` int NOT NULL COMMENT 'User ID',
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'LLM provider',
  `total_requests` bigint DEFAULT '0' COMMENT 'Lifetime total requests',
  `successful_requests` bigint DEFAULT '0' COMMENT 'Lifetime successful requests',
  `failed_requests` bigint DEFAULT '0' COMMENT 'Lifetime failed requests',
  `total_function_calls` bigint DEFAULT '0' COMMENT 'Lifetime total function calls',
  `total_mcp_calls` bigint DEFAULT '0' COMMENT 'Lifetime total MCP tool calls',
  `total_voice_requests` bigint DEFAULT '0' COMMENT 'Lifetime total voice requests',
  `total_audio_seconds` decimal(12,2) DEFAULT '0.00' COMMENT 'Lifetime total audio seconds',
  `total_voice_cost_usd` decimal(12,6) DEFAULT '0.000000' COMMENT 'Lifetime total voice cost',
  `total_tokens` bigint DEFAULT '0' COMMENT 'Lifetime total tokens',
  `total_cost_usd` decimal(12,6) DEFAULT '0.000000' COMMENT 'Lifetime total cost',
  `month_requests` int DEFAULT '0' COMMENT 'Current month requests',
  `month_tokens` bigint DEFAULT '0' COMMENT 'Current month tokens',
  `month_cost_usd` decimal(12,6) DEFAULT '0.000000' COMMENT 'Current month cost',
  `month_function_calls` int DEFAULT '0' COMMENT 'Current month function calls',
  `month_mcp_calls` int DEFAULT '0' COMMENT 'Current month MCP tool calls',
  `month_voice_requests` int DEFAULT '0' COMMENT 'Current month voice requests',
  `month_audio_seconds` decimal(12,2) DEFAULT '0.00' COMMENT 'Current month audio seconds',
  `month_voice_cost_usd` decimal(12,6) DEFAULT '0.000000' COMMENT 'Current month voice cost',
  `current_month` char(7) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Current month (YYYY-MM)',
  `monthly_request_limit` int DEFAULT '10000' COMMENT 'Monthly request limit',
  `monthly_budget_usd` decimal(10,2) DEFAULT '500.00' COMMENT 'Monthly budget limit',
  `last_updated` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Current usage balance/ledger per user';

-- --------------------------------------------------------

--
-- Table structure for table `llm_usage_transactions`
--

CREATE TABLE `llm_usage_transactions` (
  `id` bigint NOT NULL COMMENT 'Unique transaction ID',
  `user_id` int NOT NULL COMMENT 'User who made the request',
  `session_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Chat session identifier',
  `conversation_id` int DEFAULT NULL COMMENT 'Link to conversation_contexts table',
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'LLM provider (claude, openai, etc.)',
  `model` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Specific model used',
  `prompt_tokens` int DEFAULT '0' COMMENT 'Input tokens (prompt)',
  `completion_tokens` int DEFAULT '0' COMMENT 'Output tokens (completion)',
  `total_tokens` int DEFAULT '0' COMMENT 'Total tokens used',
  `cost_usd` decimal(10,6) DEFAULT '0.000000' COMMENT 'Cost in USD',
  `response_time_ms` int DEFAULT NULL COMMENT 'Response time in milliseconds',
  `status` enum('success','error','timeout','rate_limited') COLLATE utf8mb4_unicode_ci DEFAULT 'success' COMMENT 'Request outcome',
  `error_message` text COLLATE utf8mb4_unicode_ci COMMENT 'Error details if status is error',
  `function_calls_count` int DEFAULT '0' COMMENT 'Number of tool/function calls made',
  `functions_called` json DEFAULT NULL COMMENT 'Array of function names called',
  `mcp_calls_count` int DEFAULT '0' COMMENT 'Number of MCP tool calls',
  `mcp_tools_called` json DEFAULT NULL COMMENT 'Array of MCP tool names called',
  `request_metadata` json DEFAULT NULL COMMENT 'Additional request info (streaming, temperature, etc.)',
  `is_voice_request` tinyint(1) DEFAULT '0' COMMENT 'Whether this was a voice/audio request',
  `audio_duration_seconds` decimal(10,2) DEFAULT NULL COMMENT 'Total audio duration in seconds (input + output)',
  `audio_input_seconds` decimal(10,2) DEFAULT NULL COMMENT 'Input audio duration in seconds',
  `audio_output_seconds` decimal(10,2) DEFAULT NULL COMMENT 'Output audio duration in seconds',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Transaction timestamp'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Detailed log of all LLM API transactions';

-- --------------------------------------------------------

--
-- Table structure for table `mcp_servers`
--

CREATE TABLE `mcp_servers` (
  `id` int NOT NULL,
  `user_id` varchar(255) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `url` varchar(500) NOT NULL,
  `description` text,
  `headers` json DEFAULT NULL,
  `enabled` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mcp_server_tools`
--

CREATE TABLE `mcp_server_tools` (
  `id` int NOT NULL,
  `server_id` int NOT NULL,
  `tool_name` varchar(255) NOT NULL,
  `tool_description` text,
  `input_schema` json DEFAULT NULL,
  `has_ui` tinyint(1) DEFAULT '0',
  `ui_resource_uri` varchar(500) DEFAULT NULL,
  `cached_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `packages`
--

CREATE TABLE `packages` (
  `role` enum('guest','prospect','user','admin') COLLATE utf8mb4_unicode_ci NOT NULL,
  `capabilities` json NOT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` bigint DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `prompt_library`
--

CREATE TABLE `prompt_library` (
  `id` int NOT NULL,
  `user_id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `parent_id` int DEFAULT NULL COMMENT 'NULL = root level, otherwise references \r\n  parent folder',
  `type` enum('folder','prompt') COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci COMMENT 'NULL for folders, contains prompt text for \r\n  prompts',
  `sort_order` int DEFAULT '0' COMMENT 'For manual ordering within same \r\n  parent',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `provider_costs`
--

CREATE TABLE `provider_costs` (
  `id` int UNSIGNED NOT NULL,
  `category` enum('llm','voice','avatar') COLLATE utf8mb4_unicode_ci NOT NULL,
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tiers` json NOT NULL,
  `pricing_url` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `scheduled_workflows`
--

CREATE TABLE `scheduled_workflows` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `workflow_id` int NOT NULL,
  `input_prompt` text,
  `scheduled_time` datetime NOT NULL,
  `status` enum('pending','running','completed','failed','paused') DEFAULT 'pending',
  `repeat_type` enum('none','hourly','daily','weekly','monthly') DEFAULT 'none',
  `repeat_interval` int DEFAULT '1',
  `last_run` datetime DEFAULT NULL,
  `next_run` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `error_message` text
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `students`
--

CREATE TABLE `students` (
  `id` int UNSIGNED NOT NULL,
  `student_token` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `native_language` enum('en','fr') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'en',
  `level` enum('A1','A2') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'A1',
  `pronunciation_coaching_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `system_llm_settings`
--

CREATE TABLE `system_llm_settings` (
  `id` int UNSIGNED NOT NULL,
  `provider_key` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `api_key` text COLLATE utf8mb4_unicode_ci,
  `model` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `base_url` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `max_tokens` int UNSIGNED DEFAULT '4096',
  `temperature` decimal(3,2) DEFAULT '0.70',
  `price_input_per_1m` decimal(10,4) DEFAULT NULL,
  `price_output_per_1m` decimal(10,4) DEFAULT NULL,
  `chat_endpoint` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `streaming` tinyint(1) DEFAULT '1',
  `supports_tools` tinyint(1) DEFAULT '1',
  `supported_models` json DEFAULT NULL,
  `api_format` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT 'openai',
  `system_prompt` text COLLATE utf8mb4_unicode_ci,
  `enabled` tinyint(1) DEFAULT '1',
  `sort_order` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `phone` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Hashed password for email/password auth, NULL for social auth only',
  `first_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `firebase_uid` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Firebase UID for social authentication',
  `provider` enum('email','google','facebook') COLLATE utf8mb4_unicode_ci DEFAULT 'email' COMMENT 'Authentication provider',
  `role` enum('guest','prospect','user','admin','affiliate') COLLATE utf8mb4_unicode_ci DEFAULT 'prospect',
  `ledger_user_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `plan` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'free',
  `profile_picture` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'URL to user profile picture',
  `email_verified` tinyint(1) DEFAULT '0',
  `last_login` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `storage_provider` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'local',
  `storage_folder` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `app_key_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `app_key_prefix` char(12) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `app_key_created_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_api_keys`
--

CREATE TABLE `user_api_keys` (
  `user_id` int NOT NULL,
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `api_key` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Encrypted API key',
  `model` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `base_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `max_tokens` int DEFAULT NULL,
  `temperature` decimal(3,2) DEFAULT NULL,
  `chat_endpoint` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `streaming` tinyint(1) DEFAULT NULL,
  `supports_tools` tinyint(1) DEFAULT NULL,
  `system_prompt` text COLLATE utf8mb4_unicode_ci,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='User custom API keys for LLM providers';

-- --------------------------------------------------------

--
-- Table structure for table `user_category_settings`
--

CREATE TABLE `user_category_settings` (
  `id` int UNSIGNED NOT NULL,
  `user_id` int UNSIGNED NOT NULL,
  `category` enum('avatar','voice') COLLATE utf8mb4_unicode_ci NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_fs_credentials`
--

CREATE TABLE `user_fs_credentials` (
  `id` int NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `provider` varchar(50) NOT NULL,
  `credentials` json NOT NULL,
  `expires_at` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_mcp_overrides`
--

CREATE TABLE `user_mcp_overrides` (
  `id` int NOT NULL,
  `user_id` bigint NOT NULL,
  `server_id` int NOT NULL,
  `allowed` tinyint(1) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_memories`
--

CREATE TABLE `user_memories` (
  `user_id` int NOT NULL,
  `scope` enum('memory','user') COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_memory_events`
--

CREATE TABLE `user_memory_events` (
  `id` bigint UNSIGNED NOT NULL,
  `user_id` int NOT NULL,
  `scope` enum('memory','user') COLLATE utf8mb4_unicode_ci NOT NULL,
  `source` enum('manual','auto_extract','revert','compact') COLLATE utf8mb4_unicode_ci NOT NULL,
  `before_content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `after_content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `rationale` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `session_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_memory_settings`
--

CREATE TABLE `user_memory_settings` (
  `user_id` int NOT NULL,
  `auto_update_enabled` tinyint(1) NOT NULL DEFAULT '1',
  `auto_update_model` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_model_selections`
--

CREATE TABLE `user_model_selections` (
  `user_id` int NOT NULL,
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `model` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='User selected models per LLM provider';

-- --------------------------------------------------------

--
-- Table structure for table `user_provider_settings`
--

CREATE TABLE `user_provider_settings` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `category` enum('avatar','voice') COLLATE utf8mb4_unicode_ci NOT NULL,
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `api_key` text COLLATE utf8mb4_unicode_ci,
  `settings` json DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '0',
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='User-specific avatar and voice provider settings';

-- --------------------------------------------------------

--
-- Table structure for table `webauthn_challenges`
--

CREATE TABLE `webauthn_challenges` (
  `challenge` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `action` varchar(20) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `webauthn_credentials`
--

CREATE TABLE `webauthn_credentials` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `credential_id` varchar(255) NOT NULL,
  `public_key` text NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_edges`
--

CREATE TABLE `workflow_edges` (
  `id` int NOT NULL,
  `workflow_id` int NOT NULL,
  `from_node_id` int NOT NULL,
  `to_node_id` int NOT NULL,
  `from_port` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'output_1',
  `to_port` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'input_1',
  `condition_expr` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_executions`
--

CREATE TABLE `workflow_executions` (
  `id` int NOT NULL,
  `workflow_id` int NOT NULL,
  `user_id` int NOT NULL,
  `status` enum('pending','running','completed','failed','cancelled') COLLATE utf8mb4_unicode_ci DEFAULT 'pending',
  `current_step` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `input` json DEFAULT NULL,
  `output` json DEFAULT NULL,
  `step_results` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_unicode_ci,
  `total_tokens` int DEFAULT '0',
  `total_cost_usd` decimal(10,6) DEFAULT '0.000000',
  `started_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_nodes`
--

CREATE TABLE `workflow_nodes` (
  `id` int NOT NULL,
  `workflow_id` int NOT NULL,
  `node_type` enum('start','output','agent','parallel') COLLATE utf8mb4_unicode_ci NOT NULL,
  `agent_id` int DEFAULT NULL,
  `config` json DEFAULT NULL,
  `pos_x` int NOT NULL DEFAULT '0',
  `pos_y` int NOT NULL DEFAULT '0',
  `drawflow_node_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `workflow_schemas`
--

CREATE TABLE `workflow_schemas` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(100) NOT NULL,
  `description` text,
  `schema_json` json NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `affiliates`
--
ALTER TABLE `affiliates`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_affiliate_key` (`affiliate_key`),
  ADD UNIQUE KEY `uq_affiliate_user` (`user_id`);

--
-- Indexes for table `affiliate_accounts`
--
ALTER TABLE `affiliate_accounts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_affiliate_product` (`affiliate_id`,`product_id`),
  ADD KEY `fk_acct_product` (`product_id`);

--
-- Indexes for table `affiliate_products`
--
ALTER TABLE `affiliate_products`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `affiliate_sales`
--
ALTER TABLE `affiliate_sales`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_sale_external` (`external_ref`),
  ADD KEY `idx_sale_affiliate` (`affiliate_id`),
  ADD KEY `idx_sale_product` (`product_id`);

--
-- Indexes for table `agents`
--
ALTER TABLE `agents`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_agents_user` (`user_id`),
  ADD KEY `idx_agents_visibility` (`visibility`),
  ADD KEY `idx_agents_type` (`agent_type`),
  ADD KEY `idx_agents_enabled` (`enabled`),
  ADD KEY `parent_agent_id` (`parent_agent_id`),
  ADD KEY `idx_team` (`team_id`),
  ADD KEY `idx_agents_order` (`team_id`,`display_order`),
  ADD KEY `idx_agents_category` (`user_id`,`category`);

--
-- Indexes for table `agent_conversations`
--
ALTER TABLE `agent_conversations`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_agent_conversations_agent` (`agent_id`),
  ADD KEY `idx_agent_conversations_user` (`user_id`),
  ADD KEY `idx_agent_conversations_context` (`context_id`);

--
-- Indexes for table `agent_executions`
--
ALTER TABLE `agent_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_executions_parent` (`parent_execution_id`),
  ADD KEY `idx_executions_agent` (`agent_id`),
  ADD KEY `idx_executions_user` (`user_id`),
  ADD KEY `idx_executions_status` (`status`),
  ADD KEY `idx_executions_started` (`started_at`);

--
-- Indexes for table `agent_teams`
--
ALTER TABLE `agent_teams`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user` (`user_id`),
  ADD KEY `idx_workspace` (`workspace_id`);

--
-- Indexes for table `agent_workflows`
--
ALTER TABLE `agent_workflows`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_workflows_user_name` (`user_id`,`name`),
  ADD KEY `idx_workflows_user` (`user_id`),
  ADD KEY `idx_workflows_workspace` (`workspace_id`),
  ADD KEY `idx_workflows_enabled` (`enabled`);

--
-- Indexes for table `agent_workflow_executions`
--
ALTER TABLE `agent_workflow_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_workflow` (`workflow_id`),
  ADD KEY `idx_user` (`user_id`),
  ADD KEY `idx_status` (`status`);

--
-- Indexes for table `app_keys`
--
ALTER TABLE `app_keys`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_prefix` (`key_prefix`),
  ADD KEY `idx_user_app` (`user_id`,`application_id`);

--
-- Indexes for table `chat_attachments`
--
ALTER TABLE `chat_attachments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_id` (`user_id`),
  ADD KEY `idx_created_at` (`created_at`);

--
-- Indexes for table `conversation_contexts`
--
ALTER TABLE `conversation_contexts`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_id` (`user_id`),
  ADD KEY `idx_created_at` (`created_at` DESC),
  ADD KEY `idx_user_created` (`user_id`,`created_at` DESC),
  ADD KEY `idx_provider` (`provider`);
ALTER TABLE `conversation_contexts` ADD FULLTEXT KEY `ft_context` (`context_data`);

--
-- Indexes for table `exchange_rates`
--
ALTER TABLE `exchange_rates`
  ADD PRIMARY KEY (`currency`);

--
-- Indexes for table `hume_tool_mapping`
--
ALTER TABLE `hume_tool_mapping`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `tool_name` (`tool_name`),
  ADD KEY `idx_tool_name` (`tool_name`),
  ADD KEY `idx_hume_tool_id` (`hume_tool_id`),
  ADD KEY `idx_last_synced` (`last_synced`);

--
-- Indexes for table `llm_usage_balance`
--
ALTER TABLE `llm_usage_balance`
  ADD PRIMARY KEY (`user_id`,`provider`),
  ADD KEY `idx_user` (`user_id`),
  ADD KEY `idx_current_month` (`current_month`);

--
-- Indexes for table `llm_usage_transactions`
--
ALTER TABLE `llm_usage_transactions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_created` (`user_id`,`created_at`),
  ADD KEY `idx_provider_created` (`provider`,`created_at`),
  ADD KEY `idx_user_provider_created` (`user_id`,`provider`,`created_at`),
  ADD KEY `idx_session` (`session_id`),
  ADD KEY `idx_conversation` (`conversation_id`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_created` (`created_at`),
  ADD KEY `idx_voice_requests` (`is_voice_request`,`created_at`),
  ADD KEY `idx_function_calls` (`function_calls_count`),
  ADD KEY `idx_mcp_calls` (`mcp_calls_count`);

--
-- Indexes for table `mcp_servers`
--
ALTER TABLE `mcp_servers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_scope_name` (`user_id`,`name`);

--
-- Indexes for table `mcp_server_tools`
--
ALTER TABLE `mcp_server_tools`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_server_tool` (`server_id`,`tool_name`);

--
-- Indexes for table `packages`
--
ALTER TABLE `packages`
  ADD PRIMARY KEY (`role`);

--
-- Indexes for table `prompt_library`
--
ALTER TABLE `prompt_library`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_parent` (`user_id`,`parent_id`),
  ADD KEY `idx_user_type` (`user_id`,`type`),
  ADD KEY `parent_id` (`parent_id`);

--
-- Indexes for table `provider_costs`
--
ALTER TABLE `provider_costs`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_category_provider` (`category`,`provider`);

--
-- Indexes for table `scheduled_workflows`
--
ALTER TABLE `scheduled_workflows`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_next_run` (`next_run`,`status`),
  ADD KEY `fk_scheduled_workflow` (`workflow_id`);

--
-- Indexes for table `students`
--
ALTER TABLE `students`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `student_token` (`student_token`);

--
-- Indexes for table `system_llm_settings`
--
ALTER TABLE `system_llm_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_provider` (`provider_key`),
  ADD KEY `idx_enabled` (`enabled`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`),
  ADD KEY `idx_email` (`email`),
  ADD KEY `idx_firebase_uid` (`firebase_uid`),
  ADD KEY `idx_role` (`role`),
  ADD KEY `idx_provider` (`provider`),
  ADD KEY `idx_users_phone` (`phone`),
  ADD KEY `idx_ledger_user_id` (`ledger_user_id`),
  ADD KEY `idx_app_key_hash` (`app_key_hash`);

--
-- Indexes for table `user_api_keys`
--
ALTER TABLE `user_api_keys`
  ADD PRIMARY KEY (`user_id`,`provider`),
  ADD KEY `idx_user_id` (`user_id`);

--
-- Indexes for table `user_category_settings`
--
ALTER TABLE `user_category_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_user_category` (`user_id`,`category`);

--
-- Indexes for table `user_fs_credentials`
--
ALTER TABLE `user_fs_credentials`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `user_mcp_overrides`
--
ALTER TABLE `user_mcp_overrides`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_user_server` (`user_id`,`server_id`),
  ADD KEY `idx_user_id` (`user_id`),
  ADD KEY `idx_server_id` (`server_id`);

--
-- Indexes for table `user_memories`
--
ALTER TABLE `user_memories`
  ADD PRIMARY KEY (`user_id`,`scope`);

--
-- Indexes for table `user_memory_events`
--
ALTER TABLE `user_memory_events`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_created` (`user_id`,`created_at`);

--
-- Indexes for table `user_memory_settings`
--
ALTER TABLE `user_memory_settings`
  ADD PRIMARY KEY (`user_id`);

--
-- Indexes for table `user_model_selections`
--
ALTER TABLE `user_model_selections`
  ADD PRIMARY KEY (`user_id`,`provider`),
  ADD KEY `idx_user_id` (`user_id`);

--
-- Indexes for table `user_provider_settings`
--
ALTER TABLE `user_provider_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_user_category_provider` (`user_id`,`category`,`provider`),
  ADD KEY `idx_user_category` (`user_id`,`category`);

--
-- Indexes for table `webauthn_challenges`
--
ALTER TABLE `webauthn_challenges`
  ADD PRIMARY KEY (`challenge`),
  ADD KEY `idx_created_at` (`created_at`);

--
-- Indexes for table `webauthn_credentials`
--
ALTER TABLE `webauthn_credentials`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_credential_id` (`credential_id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `workflow_edges`
--
ALTER TABLE `workflow_edges`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_edges_workflow` (`workflow_id`),
  ADD KEY `idx_edges_from` (`from_node_id`),
  ADD KEY `idx_edges_to` (`to_node_id`);

--
-- Indexes for table `workflow_executions`
--
ALTER TABLE `workflow_executions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_workflow_executions_workflow` (`workflow_id`),
  ADD KEY `idx_workflow_executions_user` (`user_id`),
  ADD KEY `idx_workflow_executions_status` (`status`);

--
-- Indexes for table `workflow_nodes`
--
ALTER TABLE `workflow_nodes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_nodes_workflow` (`workflow_id`),
  ADD KEY `idx_nodes_agent` (`agent_id`);

--
-- Indexes for table `workflow_schemas`
--
ALTER TABLE `workflow_schemas`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_id` (`user_id`,`name`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `affiliates`
--
ALTER TABLE `affiliates`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `affiliate_accounts`
--
ALTER TABLE `affiliate_accounts`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `affiliate_products`
--
ALTER TABLE `affiliate_products`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `affiliate_sales`
--
ALTER TABLE `affiliate_sales`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `agents`
--
ALTER TABLE `agents`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `agent_conversations`
--
ALTER TABLE `agent_conversations`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `agent_executions`
--
ALTER TABLE `agent_executions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `agent_teams`
--
ALTER TABLE `agent_teams`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `agent_workflows`
--
ALTER TABLE `agent_workflows`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `agent_workflow_executions`
--
ALTER TABLE `agent_workflow_executions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `app_keys`
--
ALTER TABLE `app_keys`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `chat_attachments`
--
ALTER TABLE `chat_attachments`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `conversation_contexts`
--
ALTER TABLE `conversation_contexts`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `hume_tool_mapping`
--
ALTER TABLE `hume_tool_mapping`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `llm_usage_transactions`
--
ALTER TABLE `llm_usage_transactions`
  MODIFY `id` bigint NOT NULL AUTO_INCREMENT COMMENT 'Unique transaction ID';

--
-- AUTO_INCREMENT for table `mcp_servers`
--
ALTER TABLE `mcp_servers`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mcp_server_tools`
--
ALTER TABLE `mcp_server_tools`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `prompt_library`
--
ALTER TABLE `prompt_library`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `provider_costs`
--
ALTER TABLE `provider_costs`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `scheduled_workflows`
--
ALTER TABLE `scheduled_workflows`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `students`
--
ALTER TABLE `students`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `system_llm_settings`
--
ALTER TABLE `system_llm_settings`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_category_settings`
--
ALTER TABLE `user_category_settings`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_fs_credentials`
--
ALTER TABLE `user_fs_credentials`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_mcp_overrides`
--
ALTER TABLE `user_mcp_overrides`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_memory_events`
--
ALTER TABLE `user_memory_events`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_provider_settings`
--
ALTER TABLE `user_provider_settings`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `webauthn_credentials`
--
ALTER TABLE `webauthn_credentials`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflow_edges`
--
ALTER TABLE `workflow_edges`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflow_executions`
--
ALTER TABLE `workflow_executions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflow_nodes`
--
ALTER TABLE `workflow_nodes`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `workflow_schemas`
--
ALTER TABLE `workflow_schemas`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `affiliate_accounts`
--
ALTER TABLE `affiliate_accounts`
  ADD CONSTRAINT `fk_acct_affiliate` FOREIGN KEY (`affiliate_id`) REFERENCES `affiliates` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_acct_product` FOREIGN KEY (`product_id`) REFERENCES `affiliate_products` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `affiliate_sales`
--
ALTER TABLE `affiliate_sales`
  ADD CONSTRAINT `fk_sale_affiliate` FOREIGN KEY (`affiliate_id`) REFERENCES `affiliates` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_sale_product` FOREIGN KEY (`product_id`) REFERENCES `affiliate_products` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `agents`
--
ALTER TABLE `agents`
  ADD CONSTRAINT `agents_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `agents_ibfk_2` FOREIGN KEY (`parent_agent_id`) REFERENCES `agents` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `agent_conversations`
--
ALTER TABLE `agent_conversations`
  ADD CONSTRAINT `agent_conversations_ibfk_1` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `agent_conversations_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `agent_executions`
--
ALTER TABLE `agent_executions`
  ADD CONSTRAINT `agent_executions_ibfk_1` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `agent_executions_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `agent_executions_ibfk_3` FOREIGN KEY (`parent_execution_id`) REFERENCES `agent_executions` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `agent_workflows`
--
ALTER TABLE `agent_workflows`
  ADD CONSTRAINT `agent_workflows_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `conversation_contexts`
--
ALTER TABLE `conversation_contexts`
  ADD CONSTRAINT `fk_contexts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `mcp_server_tools`
--
ALTER TABLE `mcp_server_tools`
  ADD CONSTRAINT `mcp_server_tools_ibfk_1` FOREIGN KEY (`server_id`) REFERENCES `mcp_servers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `prompt_library`
--
ALTER TABLE `prompt_library`
  ADD CONSTRAINT `prompt_library_ibfk_1` FOREIGN KEY (`parent_id`) REFERENCES `prompt_library` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_provider_settings`
--
ALTER TABLE `user_provider_settings`
  ADD CONSTRAINT `user_provider_settings_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `webauthn_credentials`
--
ALTER TABLE `webauthn_credentials`
  ADD CONSTRAINT `webauthn_credentials_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `workflow_edges`
--
ALTER TABLE `workflow_edges`
  ADD CONSTRAINT `workflow_edges_ibfk_1` FOREIGN KEY (`workflow_id`) REFERENCES `agent_workflows` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `workflow_edges_ibfk_2` FOREIGN KEY (`from_node_id`) REFERENCES `workflow_nodes` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `workflow_edges_ibfk_3` FOREIGN KEY (`to_node_id`) REFERENCES `workflow_nodes` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `workflow_executions`
--
ALTER TABLE `workflow_executions`
  ADD CONSTRAINT `workflow_executions_ibfk_1` FOREIGN KEY (`workflow_id`) REFERENCES `agent_workflows` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `workflow_executions_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `workflow_nodes`
--
ALTER TABLE `workflow_nodes`
  ADD CONSTRAINT `workflow_nodes_ibfk_1` FOREIGN KEY (`workflow_id`) REFERENCES `agent_workflows` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `workflow_nodes_ibfk_2` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE SET NULL;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
