<template>
	<div id="diagnostics" class="window" aria-label="Diagnostics">
		<div class="header">
			<SidebarToggle />
		</div>
		<div class="container">
			<router-link id="back-to-help" to="/help">« Help</router-link>
			<h1 class="title">Diagnostics</h1>

			<p v-if="store.state.serverConfiguration?.public">
				No history is stored in public mode.
			</p>
			<template v-else>
				<div class="diagnostics-actions">
					<button class="btn btn-small" :disabled="loading" @click="refresh(false)">
						Refresh
					</button>
					<button class="btn btn-small" :disabled="loading" @click="refresh(true)">
						Test disk
					</button>
					<button class="btn btn-small" :disabled="!report" @click="copy">
						{{
							copied === "done"
								? "Copied"
								: copied === "failed"
									? "Copy the selected text"
									: "Copy report"
						}}
					</button>
					<span
						class="tooltipped tooltipped-e tooltipped-no-delay"
						aria-label="No search terms, names, addresses or paths are included"
					>
						<button class="extra-help" />
					</span>
				</div>

				<p v-if="!data">Loading…</p>
				<template v-else>
					<h2>Search</h2>
					<table class="diagnostics-table">
						<tr>
							<th>Index</th>
							<td :class="indexClass">{{ indexText }}</td>
						</tr>
						<tr v-if="data.storage.thread">
							<th>
								Storage thread
								<span
									class="tooltipped tooltipped-e tooltipped-no-delay"
									aria-label="Round trip of an empty call. High while it's busy with a search or a write."
								>
									<button class="extra-help" />
								</span>
							</th>
							<td :class="{'diagnostics-bad': data.storage.thread.pingMs === null}">
								{{ threadSummary(data.storage.thread) }}
							</td>
						</tr>
						<tr v-if="data.storage.disk">
							<th>
								Disk reads
								<span
									class="tooltipped tooltipped-e tooltipped-no-delay"
									aria-label="Random 4 KiB reads of the database file. SSD: under 1 ms. Hard disk: 5–20 ms. Cached blocks read faster."
								>
									<button class="extra-help" />
								</span>
							</th>
							<td>
								median {{ ms(data.storage.disk.medianMs) }}, p90
								{{ ms(data.storage.disk.p90Ms) }}, max
								{{ ms(data.storage.disk.maxMs) }}
							</td>
						</tr>
						<tr v-if="data.storage.error">
							<th>Error</th>
							<td class="diagnostics-bad">{{ data.storage.error }}</td>
						</tr>
					</table>

					<template v-if="data.storage.searches.length">
						<h3>
							Recent searches
							<span
								class="tooltipped tooltipped-e tooltipped-no-delay"
								aria-label="lookup: only rows the index points at. scan: every message, newest first. First: until the first results showed."
							>
								<button class="extra-help" />
							</span>
						</h3>
						<table class="diagnostics-table diagnostics-searches">
							<tr>
								<th>First</th>
								<th>Total</th>
								<th>How</th>
								<th>Query</th>
								<th>Queued</th>
								<th>Term</th>
								<th>Results</th>
								<th>When</th>
							</tr>
							<tr v-for="s in data.storage.searches" :key="s.at">
								<td>{{ s.firstMs === null ? "–" : ms(s.firstMs) }}</td>
								<td>{{ ms(s.totalMs) }}</td>
								<td :class="{'diagnostics-bad': s.strategy === 'scan'}">
									{{ s.strategy
									}}{{ s.reason ? ` (${scanReasons[s.reason]})` : "" }}
								</td>
								<td>{{ ms(s.queryMs) }}</td>
								<td>{{ ms(queued(s)) }}</td>
								<td>
									{{ s.termLength }} chars{{
										s.filters.length ? ` +${s.filters.join(",")}` : ""
									}}, {{ s.scope }}{{ s.more ? ", older" : ""
									}}{{ s.cancelled ? ", cancelled" : "" }}
								</td>
								<td>{{ s.results }}</td>
								<td>{{ time(s.at) }}</td>
							</tr>
						</table>
					</template>

					<template v-if="data.storage.database">
						<h2>Database</h2>
						<table class="diagnostics-table">
							<tr>
								<th>Size</th>
								<td>
									{{ size(data.storage.database.fileBytes) }} + WAL
									{{ size(data.storage.database.walBytes) }}
								</td>
							</tr>
							<tr>
								<th>Free pages</th>
								<td>
									{{ data.storage.database.freePages }} of
									{{ data.storage.database.pages }}
								</td>
							</tr>
							<tr>
								<th>Highest row id</th>
								<td>{{ data.storage.database.maxRowId }}</td>
							</tr>
							<tr>
								<th>Journal, cache</th>
								<td>
									{{ data.storage.database.journalMode }},
									{{ size(data.storage.database.cacheKiB * 1024) }}
								</td>
							</tr>
							<tr v-if="data.storage.database.pendingClears">
								<th>Clears pending</th>
								<td>{{ data.storage.database.pendingClears }}</td>
							</tr>
							<tr>
								<th>SQLite, schema</th>
								<td>
									{{ data.storage.database.sqliteVersion }},
									{{ data.storage.database.schemaVersion }}
								</td>
							</tr>
						</table>
					</template>

					<h2>Server</h2>
					<table class="diagnostics-table">
						<tr>
							<th>Version</th>
							<td>
								{{ data.server.version
								}}{{ data.server.gitCommit ? ` (${data.server.gitCommit})` : "" }},
								Node {{ data.server.node }}
							</td>
						</tr>
						<tr>
							<th>System</th>
							<td>
								{{ data.server.platform }} {{ data.server.osRelease }}
								{{ data.server.arch
								}}{{ data.server.container ? ", container" : "" }},
								{{ data.server.cpus }} CPUs
							</td>
						</tr>
						<tr>
							<th>Memory</th>
							<td>
								{{ size(data.server.memFreeBytes) }} free of
								{{ size(data.server.memTotalBytes) }}, The Lounge uses
								{{ size(data.server.rssBytes) }}
							</td>
						</tr>
						<tr v-if="data.server.cgroup">
							<th>Container</th>
							<td>{{ cgroupSummary(data.server.cgroup) }}</td>
						</tr>
						<tr v-if="data.server.logsDisk">
							<th>Logs disk</th>
							<td :class="{'diagnostics-bad': networkFs}">
								{{ data.server.logsDisk.fsType }},
								{{ size(data.server.logsDisk.freeBytes) }} free of
								{{ size(data.server.logsDisk.totalBytes) }}
							</td>
						</tr>
						<tr>
							<th>
								Event loop
								<span
									class="tooltipped tooltipped-e tooltipped-no-delay"
									aria-label="How late the server ran its work since the last refresh. Over 100 ms is felt."
								>
									<button class="extra-help" />
								</span>
							</th>
							<td>
								p99 {{ ms(data.server.eventLoop.p99Ms) }}, max
								{{ ms(data.server.eventLoop.maxMs) }}
							</td>
						</tr>
						<tr>
							<th>Uptime</th>
							<td>{{ Math.round(data.server.uptimeS / 60) }} min</td>
						</tr>
						<tr>
							<th>Storage</th>
							<td>
								{{ data.server.config.messageStorage.join(", ") || "none" }}, max
								history {{ data.server.config.maxHistory }}, cleanup
								{{ data.server.config.storagePolicy }}
							</td>
						</tr>
						<tr>
							<th>You</th>
							<td>
								{{ data.user.networks }} networks ({{
									data.user.connectedNetworks
								}}
								connected), {{ data.user.channels }} channels
							</td>
						</tr>
					</table>

					<h2>Browser</h2>
					<table v-if="browser" class="diagnostics-table">
						<tr>
							<th>App</th>
							<td>{{ browser.standalone ? "installed" : "browser tab" }}</td>
						</tr>
						<tr>
							<th>Connection</th>
							<td>
								{{ browser.transport }}, round trip {{ ms(browser.roundTripMs) }}
							</td>
						</tr>
						<tr v-for="(s, i) in browser.searches" :key="s.at">
							<th>
								{{ i === 0 ? "Searches" : "" }}
								<span
									v-if="i === 0"
									class="tooltipped tooltipped-e tooltipped-no-delay"
									aria-label="As this browser saw them: waiting for the answer, then showing it"
								>
									<button class="extra-help" />
								</span>
							</th>
							<td>{{ browserSearchSummary(s) }}</td>
						</tr>
					</table>

					<h2>Report</h2>
					<pre class="diagnostics-report">{{ report }}</pre>
				</template>
			</template>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, onMounted, onUnmounted, ref} from "vue";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import SidebarToggle from "../SidebarToggle.vue";
import friendlysize from "../../js/helpers/friendlysize";
import copyText from "../../js/helpers/copyText";
import {
	BrowserDiagnostics,
	browserSearchSummary,
	cgroupSummary,
	diagnosticsReport,
	indexSummary,
	ms,
	scanReasons,
	searchQueuedMs,
	threadSummary,
} from "../../js/helpers/diagnosticsReport";
import {browserSearches} from "../../js/searchTiming";
import type {Diagnostics} from "../../../shared/types/storage";

const networkFilesystems = ["nfs", "cifs", "smb2", "9p", "fuse", "ceph"];

export default defineComponent({
	name: "Diagnostics",
	components: {
		SidebarToggle,
	},
	setup() {
		const store = useStore();
		const data = ref<Diagnostics | null>(null);
		const browser = ref<BrowserDiagnostics | null>(null);
		const loading = ref(false);
		const copied = ref<"no" | "done" | "failed">("no");
		let sentAt = 0;

		const onDiagnostics = (received: Diagnostics) => {
			browser.value = {
				standalone:
					window.matchMedia("(display-mode: standalone)").matches ||
					(navigator as {standalone?: boolean}).standalone === true,
				transport: socket.io.engine?.transport?.name ?? "unknown",
				roundTripMs: performance.now() - sentAt,
				searches: [...browserSearches],
			};
			data.value = received;
			loading.value = false;
		};

		const refresh = (disk: boolean) => {
			loading.value = true;
			copied.value = "no";
			sentAt = performance.now();
			socket.emit("diagnostics", {disk});
		};

		const report = computed(() =>
			data.value && browser.value ? diagnosticsReport(data.value, browser.value) : ""
		);

		const indexText = computed(() => (data.value ? indexSummary(data.value.storage) : ""));
		const indexClass = computed(() =>
			data.value?.storage.index?.state === "complete" ? "" : "diagnostics-bad"
		);
		const networkFs = computed(() =>
			networkFilesystems.includes(data.value?.server.logsDisk?.fsType ?? "")
		);

		const copy = async () => {
			if (await copyText(report.value)) {
				copied.value = "done";
				return;
			}

			// Neither way works here: select the report to copy by hand
			copied.value = "failed";
			const pre = document.querySelector(".diagnostics-report");
			const selection = window.getSelection();

			if (pre && selection) {
				selection.selectAllChildren(pre);
			}
		};

		const queued = searchQueuedMs;

		const time = (at: number) => new Date(at).toLocaleTimeString();

		onMounted(() => {
			socket.on("diagnostics", onDiagnostics);

			if (!store.state.serverConfiguration?.public) {
				refresh(false);
			}
		});

		onUnmounted(() => {
			socket.off("diagnostics", onDiagnostics);
		});

		return {
			store,
			data,
			browser,
			loading,
			copied,
			report,
			indexText,
			indexClass,
			networkFs,
			scanReasons,
			threadSummary,
			cgroupSummary,
			browserSearchSummary,
			refresh,
			copy,
			queued,
			time,
			ms,
			size: friendlysize,
		};
	},
});
</script>
