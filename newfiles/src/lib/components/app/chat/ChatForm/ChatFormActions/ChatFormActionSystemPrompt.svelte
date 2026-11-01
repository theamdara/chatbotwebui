<script lang="ts">
	import { Check, MessageSquareText, Pencil, Plus, Star, Trash2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Drawer from '$lib/components/ui/drawer';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ICON_CLASS_DEFAULT, INPUT_CLASSES } from '$lib/constants';
	import { deviceStore, systemPromptsStore } from '$lib/stores';
	import type { SystemPromptEntry } from '$lib/types';

	/**
	 * ChatFormActionSystemPrompt - prompt-library picker in the chat bar
	 *
	 * Shows which saved system prompt a new chat will start with and lets you
	 * switch it, or add/edit/delete prompts right from the menu. Selections
	 * persist server-side (SQLite via /api/db). "None" disables auto-applying
	 * so chats start without a system prompt until one is picked.
	 */

	// menu renders inline (not portaled) so the row action buttons keep receiving clicks
	let isOpen = $state(false);
	let isMobile = $derived(deviceStore.isMobile);

	const prompts = $derived(systemPromptsStore.prompts);
	const defaultId = $derived(systemPromptsStore.defaultPromptId);

	// editor dialog state
	let editing = $state<SystemPromptEntry | null>(null);
	let editorOpen = $state(false);
	let editorName = $state('');
	let editorContent = $state('');

	function openEditor(entry?: SystemPromptEntry): void {
		editing = entry ?? null;
		editorName = entry?.name ?? '';
		editorContent = entry?.content ?? '';
		isOpen = false;
		editorOpen = true;
	}

	function saveEditor(): void {
		const name = editorName.trim();
		const content = editorContent.trim();

		if (!name || !content) return;

		if (editing) systemPromptsStore.update(editing.id, { content, name });
		else systemPromptsStore.add(name, content);

		editorOpen = false;
	}

	function removePrompt(entry: SystemPromptEntry): void {
		systemPromptsStore.remove(entry.id);
	}

	let triggerLabel = $derived(
		defaultId ? (prompts.find((p) => p.id === defaultId)?.name ?? 'None') : 'None'
	);

	function select(id: string | null): void {
		systemPromptsStore.setDefault(id);
		isOpen = false;
	}
</script>

{#snippet promptRow(entry: SystemPromptEntry)}
	<div
		class="group/row flex w-full items-center gap-1 rounded-md transition-colors hover:bg-accent"
	>
		<button
			class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md py-2 pl-3 text-left text-sm"
			onclick={() => select(entry.id)}
			type="button"
		>
			{#if entry.id === defaultId}
				<Check class="{ICON_CLASS_DEFAULT} shrink-0 text-foreground" />
			{:else}
				<div class="{ICON_CLASS_DEFAULT} shrink-0"></div>
			{/if}

			<span class="min-w-0 flex-1 truncate">{entry.name}</span>
		</button>

		<button
			class="cursor-pointer rounded p-1 opacity-0 transition-opacity hover:bg-muted-foreground/15 group-hover/row:opacity-100 {entry.id ===
			defaultId
				? 'opacity-60'
				: ''}"
			onclick={() => select(entry.id)}
			title="Use as default for new chats"
			type="button"
		>
			<Star
				class="h-3.5 w-3.5 {entry.id === defaultId
					? 'fill-foreground text-foreground'
					: 'text-muted-foreground'}"
			/>
		</button>

		<button
			class="cursor-pointer rounded p-1 opacity-0 transition-opacity hover:bg-muted-foreground/15 group-hover/row:opacity-100"
			onclick={() => openEditor(entry)}
			title="Edit prompt"
			type="button"
		>
			<Pencil class="h-3.5 w-3.5 text-muted-foreground" />
		</button>

		<button
			class="cursor-pointer rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 group-hover/row:opacity-100"
			onclick={() => removePrompt(entry)}
			title="Delete prompt"
			type="button"
		>
			<Trash2 class="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
		</button>
	</div>
{/snippet}

{#snippet menuContent()}
	<div class="flex max-h-[min(60vh,24rem)] min-w-56 flex-col">
		<div class="overflow-y-auto py-1">
			<button
				class="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
				onclick={() => select(null)}
				type="button"
			>
				{#if defaultId === null}
					<Check class="{ICON_CLASS_DEFAULT} shrink-0 text-foreground" />
				{:else}
					<div class="{ICON_CLASS_DEFAULT} shrink-0"></div>
				{/if}

				<span class="min-w-0 flex-1">None</span>
			</button>

			{#each prompts as entry (entry.id)}
				{@render promptRow(entry)}
			{/each}
		</div>

		<button
			class="flex w-full cursor-pointer items-center gap-3 border-t px-3 py-2 text-left text-sm hover:bg-accent"
			onclick={() => openEditor()}
			type="button"
		>
			<Plus class="{ICON_CLASS_DEFAULT} shrink-0" />

			<span>New prompt…</span>
		</button>
	</div>
{/snippet}

{#if isMobile}
	<Button
		aria-label="System prompt for new chats"
		class="h-auto max-w-40 gap-1 rounded-sm bg-transparent! px-1.75! py-1 text-xs backdrop-blur-none!"
		onclick={() => (isOpen = true)}
		variant="ghost"
	>
		<span class="flex items-center gap-0.75">
			<MessageSquareText class="size-3.25 shrink-0 max-md:size-4" />

			<span class="truncate">{triggerLabel}</span>
		</span>
	</Button>

	<Drawer.Root bind:open={isOpen}>
		<Drawer.Content>
			<Drawer.Header>
				<Drawer.Title>System prompt for new chats</Drawer.Title>
			</Drawer.Header>

			{@render menuContent()}
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<DropdownMenu.Root bind:open={isOpen}>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					aria-label="System prompt for new chats"
					class="-mr-px h-6 min-w-6 max-w-40 gap-1 rounded-sm bg-transparent px-1.75! py-0 text-xs backdrop-blur-none! hover:bg-muted-foreground/15 data-[state=open]:bg-muted-foreground/15"
					variant="ghost"
				>
					<span class="flex items-center gap-0.75">
						<MessageSquareText class="size-3.25 shrink-0" />

						<span class="truncate">{triggerLabel}</span>
					</span>
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>

		<DropdownMenu.Content align="end" class="p-0">
			{@render menuContent()}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Edit prompt' : 'New prompt'}</Dialog.Title>
		</Dialog.Header>

		<div class="flex flex-col gap-3 py-2">
			<input
				bind:value={editorName}
				class={INPUT_CLASSES}
				placeholder="Name (e.g. Code reviewer)"
			/>

			<textarea
				bind:value={editorContent}
				class="{INPUT_CLASSES} min-h-32"
				placeholder="System prompt content…"
			></textarea>
		</div>

		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button {...props} variant="ghost">Cancel</Button>
				{/snippet}
			</Dialog.Close>

			<Button disabled={!editorName.trim() || !editorContent.trim()} onclick={saveEditor}>
				Save
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
