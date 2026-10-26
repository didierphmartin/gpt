import { ToolsManager } from '../Services/ToolsManager';
import { SearchFunctions } from '../Functions/SearchFunctions';
import { PortfolioFunctions } from '../Functions/PortfolioFunctions';
import { WatchlistFunctions } from '../Functions/WatchlistFunctions';
import { AnalysisFunctions } from '../Functions/AnalysisFunctions';

/**
 * The built-in tools of PHP's AgentController / AgentMCPController runner: a fresh
 * AIPortfolioAssistant registers the search functions, then setDatabase() adds the portfolio,
 * watchlist and analysis functions — in that order.
 */
export function agentBuiltinTools(): ToolsManager {
  const tools = new ToolsManager();
  SearchFunctions.register(tools);
  PortfolioFunctions.register(tools);
  WatchlistFunctions.register(tools);
  AnalysisFunctions.register(tools);
  return tools;
}
