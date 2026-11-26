import { list, object } from './codex-protocol.ts';

export class CodexToolIsolationError extends Error {
  constructor() { super('Codex tool isolation could not be verified'); }
}

export const disabledFeatures = [
  'agent_message_board', 'agent_message_board_mcp', 'api_key_cyber_access_programs', 'apps',
  'apps_early_resource_discovery', 'auth_elicitation', 'bedrock_setup_wizard', 'browser_annotation_api',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'cli_daybreak', 'code_mode',
  'code_mode_host', 'code_mode_host_grpc', 'computer_use', 'daemon_auto_start', 'daybreak_program_propagation',
  'enable_mcp_apps', 'exec_permission_approvals', 'goals', 'hooks', 'image_generation', 'in_app_browser',
  'in_app_local_automation', 'mcp_oauth_refresh_coordination', 'mcp_shared_repl_cwd', 'memories',
  'multi_agent', 'multi_agent_v2', 'multi_agent_v2_dynamic_tools', 'multi_environment_mcp', 'network_proxy',
  'plugin_sharing', 'plugins', 'recommended_plugins', 'remote_plugin', 'request_permissions_tool',
  'runtime_agent_instances', 'skill_mcp_dependency_install', 'skill_search', 'standalone_web_search',
  'subagent_thread_environments', 'tool_call_mcp_elicitation', 'tool_suggest', 'web_search_cached',
  'web_search_request', 'workspace_dependencies',
] as const;

// Features enabled by the reviewed App Server that do not expose host or remote tools.
const allowedFeatures = new Set([
  'api_key_model_discovery', 'code_mode_host_output_truncation', 'code_mode_interrupt', 'collaboration_modes',
  'compaction_image_budget', 'content_item_kinds', 'deferred_tool_world_state', 'enable_request_compression',
  'fast_mode', 'guardian_approval', 'guardian_include_additional_context', 'guardian_reuse_parent_compaction',
  'in_app_chat', 'in_app_dictation', 'in_app_updates', 'in_app_voice', 'incremental_tools', 'incremental_tools_legacy',
  'incremental_tools_legacy_gcp', 'instant_interrupt', 'item_ids', 'mcp_lazy_stdio_startup', 'mentions_v2',
  'prediction_preserve_parent_tools', 'realtime_conversation', 'reasoning_effort_override', 'resize_all_images',
  'retain_client_tool_outputs', 'shell_snapshot', 'shell_tool', 'sleep_tool', 'sqlite', 'steer', 'system_proxy_fallback',
  'terminal_resize_reflow', 'tool_search_always_defer_mcp_tools', 'tui_app_server', 'tui_workspace', 'ultrafast_mode',
  'unbounded_connection_retries', 'unified_exec', 'unified_exec_tty', 'unified_image_budget', 'untrusted_as_tool_output',
  'view_image', 'worktrees', 'write_stdin_approval',
]);

const hookEvents = [
  'PreModelRequest', 'PostModelRequest', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact',
  'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
];
const listIsEmpty = (value: unknown) => Array.isArray(value) && value.length === 0;
const categories = ['mcp_servers', 'plugins'] as const;
type Registrations = Record<typeof categories[number], Set<string>>;

export function runnerConfigArgs(profile: string, data: string, disabled: Registrations) {
  const registrations = categories.map(category => {
    const entries = [...disabled[category]].map(name => `${JSON.stringify(name)}={enabled=false}`);
    return `${category}={${entries.join(',')}}`;
  });
  const config = [
    ...registrations,
    `hooks={${hookEvents.map(event => `${event}=[]`).join(',')}}`,
    'apps={_default={enabled=false,destructive_enabled=false,open_world_enabled=false}}',
    'features.mcp_lazy_stdio_startup=true',
    'web_search="disabled"', 'notify=[]', 'allow_login_shell=false', 'model_provider="openai"',
    `permissions.${profile}={filesystem={":minimal"="read",":workspace_roots"="read",${JSON.stringify(data)}="deny"},network={enabled=false}}`,
    `default_permissions="${profile}"`,
  ];
  return [...disabledFeatures.flatMap(name => ['--disable', name]), ...config.flatMap(value => ['-c', value])];
}

export const emptyRegistrations = (): Registrations => ({ mcp_servers: new Set(), plugins: new Set() });

export function unsafeRegistrations(config: Record<string, unknown>) {
  const enabled = emptyRegistrations();
  for (const category of categories) {
    const entries = Object.entries(object(config[category]));
    if (entries.length > 256) throw new CodexToolIsolationError();
    for (const [name, value] of entries) {
      if (!name || name.length > 160 || !name.isWellFormed() || /\p{Cc}/u.test(name)) throw new CodexToolIsolationError();
      if (object(value).enabled !== false) enabled[category].add(name);
    }
  }
  return enabled;
}

export function confirmRunnerConfig(config: Record<string, unknown>, profile: string, data: string) {
  const features = object(config.features);
  const apps = object(object(config.apps)._default);
  const hooks = object(config.hooks);
  const rule = object(object(config.permissions)[profile]);
  const fileSystem = object(rule.filesystem);
  const network = object(rule.network);
  if (config.default_permissions !== profile || rule.extends != null || rule.workspace_roots != null ||
      fileSystem[':minimal'] !== 'read' || fileSystem[':workspace_roots'] !== 'read' || fileSystem[data] !== 'deny' ||
      Object.keys(fileSystem).some(key => ![':minimal', ':workspace_roots', data, 'glob_scan_max_depth'].includes(key)) ||
      fileSystem.glob_scan_max_depth != null || network.enabled !== false ||
      Object.entries(network).some(([key, value]) => key !== 'enabled' && value != null) ||
      features.mcp_lazy_stdio_startup !== true || disabledFeatures.some(name => features[name] !== false) ||
      apps.enabled !== false || apps.destructive_enabled !== false || apps.open_world_enabled !== false ||
      hookEvents.some(event => !listIsEmpty(hooks[event])) || Object.values(hooks).some(value => !listIsEmpty(value)) ||
      config.web_search !== 'disabled' || !listIsEmpty(config.notify) || config.allow_login_shell !== false ||
      config.model_provider !== 'openai') throw new CodexToolIsolationError();
}

export function confirmRunnerFeatures(value: unknown) {
  const response = object(value);
  const seen = new Map<string, boolean>();
  for (const raw of list(response.data)) {
    const { name, enabled } = object(raw);
    if (typeof name !== 'string' || typeof enabled !== 'boolean' || seen.has(name) ||
        (enabled && !allowedFeatures.has(name))) throw new CodexToolIsolationError();
    seen.set(name, enabled);
  }
  if (response.nextCursor !== null || seen.get('mcp_lazy_stdio_startup') !== true ||
      disabledFeatures.some(name => seen.get(name) !== false)) throw new CodexToolIsolationError();
}
