import type { FolderNoteAPI } from "@aidenlx/folder-note-core"
import { getApi, registerApi, isPluginEnabled } from "@aidenlx/folder-note-core"
import { assert } from "console";
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder
	} from 'obsidian';

interface WaypointSettings {
	waypointFlag: string
	stopScanAtFolderNotes: boolean,
	showFolderNotes: boolean,
	showNonMarkdownFiles: boolean,
	debugLogging: boolean,
	useWikiLinks: boolean,
	showEnclosingNote: boolean
}

const DEFAULT_SETTINGS: WaypointSettings = {
	waypointFlag: "%% Waypoint %%",
	stopScanAtFolderNotes: false,
	showFolderNotes: false,
	showNonMarkdownFiles: false,
	debugLogging: false,
	useWikiLinks: true,
	showEnclosingNote: false
}

function indent(text: string): string {
	return text.split('\n').map(s => s ? '\t' + s : s).join('\n');
}

export default class Waypoint extends Plugin {
	static readonly BEGIN_WAYPOINT = "%% Begin Waypoint %%";
	static readonly END_WAYPOINT = "%% End Waypoint %%";

	foldersWithChanges = new Set<TFolder>();
	settings: WaypointSettings;
	fnAPI: FolderNoteAPI | null;
	initialized: boolean;

	tryGetFolderNoteAPI() {
		this.fnAPI = getApi(this);
		if (!this.fnAPI) {
			const message = "Cant load folder-note-core for some reason"
			new Notice(message);
			throw new Error(message);
		}
	}

	async onload() {
		this.initialized = false;

		// This adds a settings tab so the user can configure various aspects of the plugin
		await this.loadSettings();
		this.addSettingTab(new WaypointSettingsTab(this.app, this));

		if (!isPluginEnabled(this)) {
			const message = "This fork of Waypoint only works with folder-note-core plugin!"
			new Notice(message);
			throw new Error(message);
		}

		const timeoutId = window.setTimeout(() => {
			if (!this.initialized) {
				throw new Error(
					"folder-note-core enabled but fail to load within 5s",
				);
			}
		}, 5000);

		const init = () => {
			// Guard for initalization
			if (this.initialized) return;
			if (!this.fnAPI) return;
			this.initialized = true;
			window.clearInterval(timeoutId);
			// Register events after layout is built to avoid initial wave of 'create' events
			this.app.workspace.onLayoutReady(this.registerVaultEvents.bind(this));
			this.registerEvent(this.app.vault.on("folder-note:cfg-changed", () => { this.fnAPI = getApi(this) }));
			new Notice("Waypoint plugin loaded");
		};

		// plan lazy initialization, if we are loading before the API
		this.fnAPI = registerApi(this, (api) => {
			this.fnAPI = api;
			init();
		});

		// try proactive initialization if we are loading after API
		init();
	}

	registerVaultEvents() {
		this.registerEvent(this.app.vault.on("create", this.eventHandler.bind(this, "create")));
		this.registerEvent(this.app.vault.on("modify", this.eventHandler.bind(this, "modify")));
		this.registerEvent(this.app.vault.on("delete", this.eventHandler.bind(this, "delete")));
		this.registerEvent(this.app.vault.on("rename", this.eventHandler.bind(this, "rename")));
	}

	eventHandler(name: string, node: TAbstractFile, oldPath?: string) {
		this.log(`handler ${name}: ${node.path}`);
		const addFolder = (folder: TFolder) => {
			if (folder) {
				this.foldersWithChanges.add(folder);
			}
		}
		let folder: TFolder = node.parent;
		if (node instanceof TFile) {
			// Folder notes might live outside the folder, that should be scanned
			const linked = this.fnAPI.getFolderFromNote(node.path);
			if (linked) {
				this.log(`handler ${name}: ${node.path} is a waypoint, pointing at ${linked.path}`);
				folder = linked;
				// But this folder note might be(came) a waypoint.
				// Such event should trigger update on two waypoints: this one, and its parent.
				addFolder(folder.parent);
			}
		}
		addFolder(folder);
		if (oldPath) {
			const parentFolder = this.getParentFolder(oldPath);
			addFolder(parentFolder);
		}
		this.scheduleUpdate();
	}

	/**
	 * Schedule an update for the changed folders after debouncing to prevent excessive updates.
	 */
	scheduleUpdate = debounce(this.updateChangedFolders.bind(this), 500, true);

	/**
	 * Scan the changed folders and their ancestors for waypoints and update them if found.
	 */
	async updateChangedFolders() {
		this.log("debouncer: updateChangedFolders");

		// swap with empty set
		let folders = new Set<TFolder>();
		[folders, this.foldersWithChanges] = [this.foldersWithChanges, folders];

		// gather waypoints into a set, so that they are processed once
		let waypoints = new Set<TFile>();
		for (const folder of folders) {
			this.log("File changes in folder: " + folder.path);
			const waypoint = await this.locateParentWaypoint(folder);
			if (waypoint) {
				waypoints.add(waypoint);
			}
		}
		waypoints.forEach(this.updateWaypointFile.bind(this));
	}

	/**
	 * Locate the ancestor waypoint (if any) of the given file/folder.
	 * @param node The node to start the search from
	 * @returns The ancestor waypoint, or null if none was found
	 */
	async locateParentWaypoint(node: TFolder): Promise<TFile> | null {
		this.log("Locating parent waypoint of " + node.path);
		let folder = node;
		while (folder) {
			const folderNote = this.fnAPI.getFolderNote(folder);
			if (await this.hasWaypointFlag(folderNote)) {
				this.log("Found folder note: " + folderNote.path);
				return folderNote;
			}
			folder = folder.parent;
		}
		this.log("No parent waypoint found.");
		return null;
	}

	/**
	 * Get the parent folder of the given filepath if it exists.
	 * @param path The filepath to search
	 * @returns The parent folder, or null if none exists
	 */
	getParentFolder(path: string): TFolder | null {
		const abstractFile = this.app.vault.getAbstractFileByPath(path.split("/").slice(0, -1).join("/"));
		if (abstractFile instanceof TFolder) {
			return abstractFile;
		} else {
			return null;
		}
	}

	onunload() { }

	isFolderNote(file: TFile): boolean {
		return !!(this.fnAPI.getFolderFromNote(file));
	}

	getCleanParentPath(node: TAbstractFile): string {
		if (node.parent instanceof TFolder && node.parent.isRoot()) {
			return "";
		} else {
			return node.parent.path + "/";
		}
	}

	async printWaypointError(file: TFile, error: string) {
		this.log("Creating waypoint error in " + file.path);
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n")
		const trimmed = lines.map(s => s.trim());
		const waypointIndex = trimmed.indexOf(this.settings.waypointFlag);
		if (waypointIndex === -1) {
			console.error("Error: No waypoint flag found while trying to print error.");
			return;
		}
		lines.splice(waypointIndex, 1, error);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	processedWaypoints = new Set<TFile>();

	/**
	 * Given a file with a waypoint flag, generate a file tree representation and update the waypoint text.
	 * @param file The file to update
	 */
	async updateWaypointFile(file: TFile) {
		if (!file) return;
		// escape constant re-update loop
		if (this.processedWaypoints.delete(file)) {
			this.log(`Waypoint ${file.path} was modified by us, skipping`);
			return;
		}

		this.log("Updating waypoint in " + file.path);
	
		const folder = this.fnAPI.getFolderFromNote(file);
		const fileTree = await this.getFolderContentMarkdown(folder, file.parent);

		const waypoint = `${Waypoint.BEGIN_WAYPOINT}\n${fileTree}\n\n${Waypoint.END_WAYPOINT}`;
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n")
		const trimmed: string[] = lines.map(line => line.trim());

		const waypointFlag = trimmed.indexOf(this.settings.waypointFlag);
		let waypointStart = -1;
		let waypointEnd = -1;
		if (waypointFlag >= 0) {
			waypointStart = waypointFlag;
			waypointEnd = waypointFlag;
		} else {
			waypointStart = trimmed.indexOf(Waypoint.BEGIN_WAYPOINT);
			waypointEnd = trimmed.indexOf(Waypoint.END_WAYPOINT, waypointStart);
		}

		if (waypointStart === -1) {
			console.error("Error: No waypoint found while trying to update " + file.path);
			return;
		}
		this.log("Waypoint found at " + waypointStart + " to " + waypointEnd);
		lines.splice(waypointStart, waypointEnd !== -1 ? waypointEnd - waypointStart + 1 : 1, waypoint);

		// remember this file, to skip it on the next "modified" event
		this.processedWaypoints.add(file);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	getMarkdownLinkFolderNote(from: TFolder, to: TFolder, folderNote?: TFile): string {
		const text = to.name;
		if (!folderNote) {
			return `- **${text}**\n`;
		}
		return this.getMarkdownLinkFile(from, folderNote, text);
	}

	getMarkdownLinkFile(from: TFolder, to: TFile, text?: string): string {
		text ??= to.basename;
		if (false && this.settings.useWikiLinks) {
			return `- [[${text}]]\n`;
		} else {
			return `- [${text}](${this.getEncodedUri(from, to)})\n`;
		}
	}

	/**
	 * Scan the given file for the waypoint flag. 
	 * No checks are done to see if it is even a Folder Note!
	 * @param file The file to scan
	 */
	async hasWaypointFlag(file?: TFile): Promise<boolean> {
		if (!file) return false;
		const text = await this.app.vault.cachedRead(file);
		const lines = text.split("\n").map(str => str.trim());
		return lines.contains(this.settings.waypointFlag) || lines.contains(Waypoint.BEGIN_WAYPOINT);
	}

	/**
	 * Generate a file tree representation of the given folder.
	 * @param node The current node in our recursive descent
	 * @param relativeTo The root of the file tree that will be generated
	 * @returns The string representation of the tree.
	 */
	async getAbstractFileMarkdown(node: TAbstractFile, relativeTo: TFolder): Promise<string> {
		this.log(`getAbstractFileMarkdown: ${node.path}`);
		if (node instanceof TFile) {
			return this.getFileMarkdown(node, relativeTo);
		} else if (node instanceof TFolder) {
			return this.getFolderMarkdown(node, relativeTo);
		}
	}

	async getFileMarkdown(file: TFile, relativeTo: TFolder): Promise<string> {
		if (this.isFolderNote(file)) {
			console.error("'%s' a folder note! It should've been filtered out by now", file.path);
		} else if (file.extension == "md") {
			return this.getMarkdownLinkFile(relativeTo, file);
		} else if (this.settings.showNonMarkdownFiles) {
			// Full name with extension
			return this.getMarkdownLinkFile(relativeTo, file, file.name);
		}
		return "";
	}

	async getFolderMarkdown(folder: TFolder, relativeTo: TFolder): Promise<string> {
		const selfFolderNote = this.fnAPI.getFolderNote(folder);
		const title = this.getMarkdownLinkFolderNote(relativeTo, folder, selfFolderNote);
		this.log(`getFolderMarkdown: ${title}`);

		if (!selfFolderNote && this.settings.stopScanAtFolderNotes)
			return title;

		if (selfFolderNote && await this.hasWaypointFlag(selfFolderNote))
			return title;

		const content = await this
			.getFolderContentMarkdown(folder, relativeTo)
			.then(indent);

		this.log(`getFolderMarkdown: ${content}`);
		return title + content;
	}

	// Only content
	async getFolderContentMarkdown(folder: TFolder, relativeTo?: TFolder): Promise<string> {
		relativeTo ??= folder;

		if (!folder.children || folder.children.length === 0) {
			// childfree folders do not get represented
			return "";
		}

		// Folder notes are referenced by their folder, yeet them out!
		const children = folder.children
			.filter(child => !(child instanceof TFile && this.isFolderNote(child as TFile)));

		if (children.length === 0) // FIXME: isn't this case already covered in the statement below?
			return "";

		return await Promise
			.all(children.map(child => this.getAbstractFileMarkdown(child, relativeTo)))
			.then(arr => arr.join(''));
	}

	/**
	 * Generate an encoded URI path to the given file that is relative to the given root.
	 * @param rootNode The from which the relative path will be generated
	 * @param node The node to which the path will be generated
	 * @returns The encoded path
	 */
	getEncodedUri(rootNode: TFolder, node: TAbstractFile) {
		if (rootNode.isRoot()) {
			return `./${encodeURI(node.path)}`;
		}
		return `./${encodeURI(node.path.substring(rootNode.path.length + 1))}`;
	}

	log(message: string) {
		if (this.settings.debugLogging) {
			console.log(message);			
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class WaypointSettingsTab extends PluginSettingTab {
	plugin: Waypoint;

	constructor(app: App, plugin: Waypoint) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: 'Waypoint Settings'});
		new Setting(containerEl)
			.setName("Show Folder Notes")
			.setDesc("If enabled, folder notes will be listed alongside other notes in the generated waypoints.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showFolderNotes)
				.onChange(async (value) => {
					this.plugin.settings.showFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Show Non-Markdown Files")
			.setDesc("If enabled, non-Markdown files will be listed alongside other notes in the generated waypoints.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showNonMarkdownFiles)
				.onChange(async (value) => {
					this.plugin.settings.showNonMarkdownFiles = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Show Enclosing Note")
			.setDesc("If enabled, the name of the folder note containing the waypoint will be listed at the top of the generated waypoints.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showEnclosingNote)
				.onChange(async (value) => {
					this.plugin.settings.showEnclosingNote = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Stop Scan at Folder Notes")
			.setDesc("If enabled, the waypoint generator will stop scanning nested folders when it encounters a folder note. Otherwise, it will only stop if the folder note contains a waypoint.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.stopScanAtFolderNotes)
				.onChange(async (value) => {
					this.plugin.settings.stopScanAtFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Use WikiLinks")
			.setDesc("If enabled, links will be generated like [[My Page]] instead of [My Page](../Folder/My%Page.md).")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useWikiLinks)
				.onChange(async (value) => {
					this.plugin.settings.useWikiLinks = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Waypoint Flag")
			.setDesc("Text flag that triggers waypoint generation in a folder note. Must be surrounded by double-percent signs.")
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.waypointFlag)
				.setValue(this.plugin.settings.waypointFlag)
				.onChange(async (value) => {
					if (value && value.startsWith("%%") && value.endsWith("%%") && value !== "%%" && value !== "%%%" && value !== "%%%%") {
						this.plugin.settings.waypointFlag = value;
					} else {
						this.plugin.settings.waypointFlag = DEFAULT_SETTINGS.waypointFlag;
						console.error("Error: Waypoint flag must be surrounded by double-percent signs.");
					}
					await this.plugin.saveSettings();
				})
			);
		const postscriptElement = containerEl.createEl("div", {
			cls: "setting-item",
		});
		const descriptionElement = postscriptElement.createDiv({cls: "setting-item-description"});
		descriptionElement.createSpan({text: "For instructions on how to use this plugin, check out the README on "});
		descriptionElement.createEl("a", { attr: { "href": "https://github.com/IdreesInc/Waypoint" }, text: "GitHub" });
		descriptionElement.createSpan({text: " or get in touch with the author "});
		descriptionElement.createEl("a", { attr: { "href": "https://twitter.com/IdreesInc" }, text: "@IdreesInc" });
		postscriptElement.appendChild(descriptionElement);
	}
}
