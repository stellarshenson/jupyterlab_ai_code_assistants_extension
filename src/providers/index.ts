// The single registration point for assistants.
//
// One line per provider. Adding an assistant means adding its module and its
// line here; removing one means deleting both. No core file is edited either
// way, and nothing outside this directory names an assistant.
//
// A provider module exports a `descriptor` (pure data - the settings-schema
// generator reads it under plain Node) and optionally `hooks` (the DOM and
// JupyterLab-aware parts). Keep module-scope side effects out of both, so the
// generator can import this barrel without a browser.

import { IProviderModule } from '../core/types';

import * as claude from './claude';
import * as codex from './codex';
import * as kimi from './kimi';
import * as gemini from './gemini';

export const PROVIDERS: IProviderModule[] = [claude, codex, kimi, gemini];

export default PROVIDERS;
