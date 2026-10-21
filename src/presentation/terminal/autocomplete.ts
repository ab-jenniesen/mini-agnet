import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type SlashCommand,
} from '@earendil-works/pi-tui';
import type { AgentClient, ProviderView } from '../../app/contracts.js';
import { commands } from '../commands.js';

export function autocomplete(client: AgentClient, providers: ProviderView[], root: string) {
  const items = (values: string[], prefix: string): AutocompleteItem[] =>
    values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
  const names = new Set<string>();
  const slashCommands: SlashCommand[] = [];
  for (const entry of commands) {
    const name = entry.completion.trim().slice(1).split(' ')[0];
    if (names.has(name)) continue;
    names.add(name);
    const command: SlashCommand = {
      name,
      description: entry.detail,
      argumentHint: entry.command.split(' ').slice(1).join(' '),
    };
    if (name === 'model' || name === 'key')
      command.getArgumentCompletions = (prefix) =>
        items(
          providers.map((provider) => provider.id),
          prefix,
        );
    if (name === 'permission')
      command.getArgumentCompletions = (prefix) => items(['read-only', 'ask', 'allow'], prefix);
    if (name === 'thinking')
      command.getArgumentCompletions = (prefix) => items(['on', 'collapse', 'off'], prefix);
    if (name === 'memories')
      command.getArgumentCompletions = (prefix) => items(['project', 'global'], prefix);
    if (name === 'session')
      command.getArgumentCompletions = async (prefix) => {
        const sessions = await client.dispatch({ type: 'sessions.list' });
        return items([...sessions, 'delete ', ...sessions.map((id) => `delete ${id}`)], prefix);
      };
    slashCommands.push(command);
  }
  return new CombinedAutocompleteProvider(slashCommands, root);
}
