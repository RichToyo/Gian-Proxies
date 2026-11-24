/** Loose inner shapes for the Kimi Code 2.7 local server API (kap-server
 *  OpenAPI/AsyncAPI). Only fields the proxy consumes are typed; everything
 *  else stays opaque. */

/** 2.7 session wire (`protocol/session.ts`): `cwd` is top-level, `activity`
 *  replaces 2.6's `busy`/`main_turn_active`, and there are no usage totals. */
export interface KimiSessionInfo {
  id: string;
  workspace_id?: string;
  cwd?: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  activity?: 'idle' | 'turn' | 'background';
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_outcome?: 'completed' | 'interrupted' | 'failed';
  archived?: boolean;
  metadata?: Record<string, unknown>;
}

export interface KimiModelInfo {
  provider?: string;
  model: string;
  display_name?: string;
  max_context_size?: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

/** Prompt content part (POST /sessions/{id}/prompts `content[]` union). */
export type KimiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: KimiMediaSource; name?: string }
  | { type: 'video'; source: KimiMediaSource; name?: string }
  | { type: 'file'; file_id?: string; path?: string; name?: string; media_type?: string; size?: number };

export type KimiMediaSource =
  | { kind: 'url'; url: string; id?: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string }
  | { kind: 'session_media'; file_id: string }
  | { kind: 'path'; path: string };
