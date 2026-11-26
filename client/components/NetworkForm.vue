<template>
	<div id="connect" ref="windowEl" class="window" role="tabpanel" aria-label="Connect">
		<div class="header">
			<SidebarToggle />
		</div>
		<nav v-if="sectioned" class="settings-menu network-menu" aria-label="Network sections">
			<ul>
				<li v-for="section in sections" :key="section.id">
					<button
						type="button"
						:class="[
							'icon',
							'network-section-' + section.id,
							{active: activeSection === section.id},
						]"
						:aria-current="activeSection === section.id ? 'true' : undefined"
						@click="jumpTo(section.id)"
					>
						{{ section.name }}
					</button>
				</li>
			</ul>
		</nav>
		<form class="container" method="post" action="" @submit.prevent="onSubmit">
			<h1 class="title">
				<template v-if="defaults.uuid">
					<input v-model="defaults.uuid" type="hidden" name="uuid" />
					Edit {{ defaults.name }}
				</template>
				<template v-else>
					Connect
					<template v-if="config?.lockNetwork"> to {{ defaults.name }} </template>
				</template>
			</h1>
			<section v-bind="sectionAttrs('connection')">
				<template v-if="!config?.lockNetwork">
					<h2>{{ heading("connection") }}</h2>
					<div class="connect-row">
						<label for="connect:name">Name</label>
						<input
							id="connect:name"
							v-model.trim="defaults.name"
							class="input"
							name="name"
							maxlength="100"
						/>
					</div>
					<div class="connect-row">
						<label for="connect:host">Server</label>
						<div class="input-wrap">
							<input
								id="connect:host"
								v-model.trim="defaults.host"
								class="input"
								name="host"
								aria-label="Server address"
								maxlength="255"
								required
							/>
							<span id="connect:portseparator">:</span>
							<input
								id="connect:port"
								v-model="defaults.port"
								class="input"
								type="number"
								min="1"
								max="65535"
								name="port"
								aria-label="Server port"
							/>
						</div>
					</div>
					<div class="connect-row">
						<label for="connect:password">Password</label>
						<RevealPassword
							v-slot:default="slotProps"
							class="input-wrap password-container"
						>
							<input
								id="connect:password"
								v-model="defaults.password"
								class="input"
								:type="slotProps.isVisible ? 'text' : 'password'"
								placeholder="Server password (optional)"
								name="password"
								maxlength="300"
							/>
						</RevealPassword>
					</div>
					<div class="connect-row">
						<label></label>
						<div class="input-wrap">
							<label class="tls">
								<input
									v-model="defaults.tls"
									type="checkbox"
									name="tls"
									:disabled="defaults.hasSTSPolicy"
								/>
								Use secure connection (TLS)
								<span
									v-if="defaults.hasSTSPolicy"
									class="tooltipped tooltipped-n tooltipped-no-delay"
									aria-label="This network has a strict transport security policy, you will be unable to disable TLS"
									>🔒 STS</span
								>
							</label>
							<label class="tls">
								<input
									v-model="defaults.rejectUnauthorized"
									type="checkbox"
									name="rejectUnauthorized"
								/>
								Only allow trusted certificates
							</label>
						</div>
					</div>

					<h2>Proxy Settings</h2>
					<div class="connect-row">
						<label></label>
						<div class="input-wrap">
							<label for="connect:proxyEnabled">
								<input
									id="connect:proxyEnabled"
									v-model="defaults.proxyEnabled"
									type="checkbox"
									name="proxyEnabled"
								/>
								Enable Proxy
							</label>
						</div>
					</div>
					<template v-if="defaults.proxyEnabled">
						<div class="connect-row">
							<label for="connect:proxyHost">SOCKS Address</label>
							<div class="input-wrap">
								<input
									id="connect:proxyHost"
									v-model.trim="defaults.proxyHost"
									class="input"
									name="proxyHost"
									aria-label="Proxy host"
									maxlength="255"
								/>
								<span id="connect:proxyPortSeparator">:</span>
								<input
									id="connect:proxyPort"
									v-model="defaults.proxyPort"
									class="input"
									type="number"
									min="1"
									max="65535"
									name="proxyPort"
									aria-label="SOCKS port"
								/>
							</div>
						</div>

						<div class="connect-row">
							<label for="connect:proxyUsername">Proxy username</label>
							<input
								id="connect:proxyUsername"
								ref="proxyUsernameInput"
								v-model.trim="defaults.proxyUsername"
								class="input username"
								name="proxyUsername"
								maxlength="100"
								placeholder="Proxy username"
							/>
						</div>

						<div class="connect-row">
							<label for="connect:proxyPassword">Proxy password</label>
							<RevealPassword
								v-slot:default="slotProps"
								class="input-wrap password-container"
							>
								<input
									id="connect:proxyPassword"
									ref="proxyPassword"
									v-model="defaults.proxyPassword"
									class="input"
									:type="slotProps.isVisible ? 'text' : 'password'"
									placeholder="Proxy password"
									name="proxyPassword"
									maxlength="300"
								/>
							</RevealPassword>
						</div>
					</template>
				</template>
				<template
					v-else-if="config.lockNetwork && !store.state.serverConfiguration?.public"
				>
					<h2>{{ heading("connection") }}</h2>
					<div class="connect-row">
						<label for="connect:name">Name</label>
						<input
							id="connect:name"
							v-model.trim="defaults.name"
							class="input"
							name="name"
							maxlength="100"
						/>
					</div>
					<div class="connect-row">
						<label for="connect:password">Password</label>
						<RevealPassword
							v-slot:default="slotProps"
							class="input-wrap password-container"
						>
							<input
								id="connect:password"
								v-model="defaults.password"
								class="input"
								:type="slotProps.isVisible ? 'text' : 'password'"
								placeholder="Server password (optional)"
								name="password"
								maxlength="300"
							/>
						</RevealPassword>
					</div>
				</template>
			</section>

			<section v-bind="sectionAttrs('identity')">
				<h2>{{ heading("identity") }}</h2>
				<div class="connect-row">
					<label for="connect:nick">Nick</label>
					<input
						id="connect:nick"
						v-model="defaults.nick"
						class="input nick"
						name="nick"
						pattern="[^\s:!@]+"
						maxlength="100"
						required
						@input="onNickChanged"
					/>
				</div>
				<template v-if="!config?.useHexIp">
					<div class="connect-row">
						<label for="connect:username">Username</label>
						<input
							id="connect:username"
							ref="usernameInput"
							v-model.trim="defaults.username"
							class="input username"
							name="username"
							maxlength="100"
						/>
					</div>
				</template>
				<div class="connect-row">
					<label for="connect:realname">Real name</label>
					<input
						id="connect:realname"
						v-model.trim="defaults.realname"
						class="input"
						name="realname"
						maxlength="300"
					/>
				</div>
				<div class="connect-row">
					<label for="connect:leaveMessage">Leave message</label>
					<input
						id="connect:leaveMessage"
						v-model.trim="defaults.leaveMessage"
						autocomplete="off"
						class="input"
						name="leaveMessage"
						placeholder="The Lounge - https://thelounge.chat"
					/>
				</div>
				<template v-if="defaults.uuid && !store.state.serverConfiguration?.public">
					<div class="connect-row">
						<label for="connect:commands">
							Commands
							<span
								class="tooltipped tooltipped-ne tooltipped-no-delay"
								aria-label="One /command per line.
Each command will be executed in
the server tab on new connection"
							>
								<button class="extra-help" />
							</span>
						</label>
						<textarea
							id="connect:commands"
							ref="commandsInput"
							autocomplete="off"
							:value="defaults.commands ? defaults.commands.join('\n') : ''"
							class="input"
							name="commands"
							@input="resizeCommandsInput"
						/>
					</div>
				</template>
				<template v-else-if="!defaults.uuid">
					<div class="connect-row">
						<label for="connect:channels">Channels</label>
						<input
							id="connect:channels"
							v-model.trim="defaults.join"
							class="input"
							name="join"
						/>
					</div>
				</template>

				<template v-if="store.state.serverConfiguration?.public">
					<template v-if="config?.lockNetwork">
						<div class="connect-row">
							<label></label>
							<div class="input-wrap">
								<label class="tls">
									<input v-model="displayPasswordField" type="checkbox" />
									I have a password
								</label>
							</div>
						</div>
						<div v-if="displayPasswordField" class="connect-row">
							<label for="connect:password">Password</label>
							<RevealPassword
								v-slot:default="slotProps"
								class="input-wrap password-container"
							>
								<input
									id="connect:password"
									ref="publicPassword"
									v-model="defaults.password"
									class="input"
									:type="slotProps.isVisible ? 'text' : 'password'"
									placeholder="Server password (optional)"
									name="password"
									maxlength="300"
								/>
							</RevealPassword>
						</div>
					</template>
				</template>
			</section>
			<section v-if="!store.state.serverConfiguration?.public" v-bind="sectionAttrs('auth')">
				<h2 id="label-auth">{{ heading("auth") }}</h2>
				<div class="connect-row connect-auth" role="group" aria-labelledby="label-auth">
					<label class="opt">
						<input
							:checked="!defaults.sasl"
							type="radio"
							name="sasl"
							value=""
							@change="setSaslAuth('')"
						/>
						No authentication
					</label>
					<label class="opt">
						<input
							:checked="defaults.sasl === 'plain'"
							type="radio"
							name="sasl"
							value="plain"
							@change="setSaslAuth('plain')"
						/>
						Username + password (SASL PLAIN)
					</label>
					<label
						v-if="!store.state.serverConfiguration?.public && defaults.tls"
						class="opt"
					>
						<input
							:checked="defaults.sasl === 'external'"
							type="radio"
							name="sasl"
							value="external"
							@change="setSaslAuth('external')"
						/>
						Client certificate (SASL EXTERNAL)
					</label>
				</div>

				<template v-if="defaults.sasl === 'plain'">
					<div class="connect-row">
						<label for="connect:username">Account</label>
						<input
							id="connect:saslAccount"
							v-model.trim="defaults.saslAccount"
							class="input"
							name="saslAccount"
							maxlength="100"
							required
						/>
					</div>
					<div class="connect-row">
						<label for="connect:password">Password</label>
						<RevealPassword
							v-slot:default="slotProps"
							class="input-wrap password-container"
						>
							<input
								id="connect:saslPassword"
								v-model="defaults.saslPassword"
								class="input"
								:type="slotProps.isVisible ? 'text' : 'password'"
								name="saslPassword"
								maxlength="300"
								required
							/>
						</RevealPassword>
					</div>
				</template>
				<div v-else-if="defaults.sasl === 'external'" class="connect-sasl-external">
					<p>The Lounge automatically generates and manages the client certificate.</p>
					<p>
						On the IRC server, you will need to tell the services to attach the
						certificate fingerprint (certfp) to your account, for example:
					</p>
					<pre><code>/msg NickServ CERT ADD</code></pre>
				</div>
			</section>

			<section v-if="sectioned" v-bind="sectionAttrs('highlights')">
				<h2>{{ heading("highlights") }}</h2>
				<div class="connect-row">
					<label for="connect:highlights">
						Words
						<span
							class="tooltipped tooltipped-ne tooltipped-no-delay"
							aria-label="Comma-separated. Messages on this network
containing any of these are highlighted."
						>
							<button type="button" class="extra-help" />
						</span>
					</label>
					<input
						id="connect:highlights"
						v-model="defaults.highlights"
						autocomplete="off"
						class="input"
						name="highlights"
						maxlength="2000"
						placeholder="e.g. deploy, on call"
					/>
				</div>
				<div class="connect-row">
					<label for="connect:highlightExceptions">
						Exceptions
						<span
							class="tooltipped tooltipped-ne tooltipped-no-delay"
							aria-label="Comma-separated. Messages containing any
of these are never highlighted, even if
they mention your nick."
						>
							<button type="button" class="extra-help" />
						</span>
					</label>
					<input
						id="connect:highlightExceptions"
						v-model="defaults.highlightExceptions"
						autocomplete="off"
						class="input"
						name="highlightExceptions"
						maxlength="2000"
					/>
				</div>
				<div class="connect-row">
					<label for="connect:globalHighlights">
						Global
						<span
							class="tooltipped tooltipped-ne tooltipped-no-delay"
							aria-label="Your highlights from Settings → Notifications.
Global exceptions always apply."
						>
							<button type="button" class="extra-help" />
						</span>
					</label>
					<input
						id="connect:globalHighlights"
						:class="[
							'input',
							'global-highlights',
							{ignored: defaults.ignoreGlobalHighlights},
						]"
						:value="globalHighlights"
						placeholder="None"
						readonly
					/>
				</div>
				<div class="connect-row">
					<label></label>
					<div class="input-wrap">
						<label class="tls">
							<input
								v-model="defaults.ignoreGlobalHighlights"
								type="checkbox"
								name="ignoreGlobalHighlights"
								value="true"
							/>
							Ignore global highlights
						</label>
					</div>
				</div>
			</section>

			<div>
				<button type="submit" class="btn" :disabled="disabled ? true : false">
					<template v-if="defaults.uuid">Save network</template>
					<template v-else>Connect</template>
				</button>
			</div>
		</form>
	</div>
</template>

<style>
#connect .settings-menu .icon::before {
	font: normal normal 900 14px/1 "Font Awesome 7 Pro";
	font-size: inherit;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
}

#connect .network-section-connection::before {
	content: "\f233"; /* server */
}

#connect .network-section-identity::before {
	content: "\f007"; /* user */
}

#connect .network-section-auth::before {
	content: "\f084"; /* key */
}

#connect .network-section-highlights::before {
	content: "\f1fa"; /* at */
}

/* The menu only earns its place beside the form; on narrow screens just scroll */
@media screen and (max-width: calc(768px + 320px)) {
	#connect .network-menu {
		display: none;
	}
}

#connect .container > section {
	margin-bottom: 25px;
}

#section-highlights label {
	white-space: nowrap;
}

#connect .global-highlights {
	color: var(--body-color-muted);
	background: transparent;
	cursor: default;
}

#connect .global-highlights.ignored {
	text-decoration: line-through;
}

#connect .connect-auth {
	display: block;
	margin-bottom: 10px;
}

#connect .connect-auth .opt {
	display: block;
	width: 100%;
}

#connect .connect-auth input {
	margin: 3px 10px 0 0;
}

#connect .connect-sasl-external {
	padding: 10px;
	border-radius: 2px;
	background-color: #d9edf7;
	color: #31708f;
}

#connect .connect-sasl-external pre {
	margin: 0;
	user-select: text;
}
</style>

<script lang="ts">
import RevealPassword from "./RevealPassword.vue";
import SidebarToggle from "./SidebarToggle.vue";
import {
	computed,
	defineComponent,
	nextTick,
	onBeforeUnmount,
	onMounted,
	PropType,
	ref,
	watch,
} from "vue";
import {useStore} from "../js/store";
import {ClientNetwork} from "../js/types";

export type NetworkFormDefaults = Partial<ClientNetwork> & {
	join?: string;
	username?: string;
	host?: string;
	commands?: string[];
	tls?: boolean;
	port?: number;
	sasl?: string;
	password?: string;
	hasSTSPolicy?: boolean;
	saslAccount?: string;
	saslPassword?: string;
	leaveMessage?: string;
	highlights?: string;
	highlightExceptions?: string;
	ignoreGlobalHighlights?: boolean;
	realname?: string;
	proxyEnabled?: boolean;
	proxyHost?: string;
	proxyPort?: number;
	proxyUsername?: string;
	proxyPassword?: string;
	rejectUnauthorized?: boolean;
};

export default defineComponent({
	name: "NetworkForm",
	components: {
		RevealPassword,
		SidebarToggle,
	},
	props: {
		handleSubmit: {
			type: Function as PropType<(network: ClientNetwork) => void>,
			required: true,
		},
		defaults: {
			type: Object as PropType<NetworkFormDefaults>,
			required: true,
		},
		disabled: Boolean,
	},
	setup(props) {
		const store = useStore();
		const config = ref(store.state.serverConfiguration);
		const previousUsername = ref(props.defaults?.username);
		const displayPasswordField = ref(false);

		const publicPassword = ref<HTMLInputElement | null>(null);

		// Editing an existing network gets a menu that jumps between sections
		const sectioned = computed(
			() => !!props.defaults?.uuid && !store.state.serverConfiguration?.public
		);

		const sections = [
			{id: "connection", name: "Server", connectName: "Network settings"},
			{id: "identity", name: "Identity", connectName: "User preferences"},
			{id: "auth", name: "Login", connectName: "Authentication"},
			{id: "highlights", name: "Highlights", connectName: "Highlights"},
		];

		const heading = (id: string) => {
			const section = sections.find((s) => s.id === id)!;
			return sectioned.value ? section.name : section.connectName;
		};

		const sectionAttrs = (id: string) => ({id: "section-" + id});

		const globalHighlights = computed(() =>
			String(store.state.settings.highlights || "")
				.split(",")
				.map((word) => word.trim())
				.filter(Boolean)
				.join(", ")
		);

		const windowEl = ref<HTMLElement | null>(null);
		const activeSection = ref(sections[0].id);
		let jumpingUntil = 0;

		// Mark the section whose heading was scrolled past last, or the last
		// one once the page is scrolled to the bottom
		const updateActiveSection = () => {
			const root = windowEl.value;

			if (!root || Date.now() < jumpingUntil) {
				return;
			}

			const present = sections.filter((s) => document.getElementById("section-" + s.id));

			if (present.length === 0) {
				return;
			}

			if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
				activeSection.value = present[present.length - 1].id;
				return;
			}

			const rootTop = root.getBoundingClientRect().top;
			let current = present[0].id;

			for (const s of present) {
				const top = document.getElementById("section-" + s.id)!.getBoundingClientRect().top;

				if (top - rootTop <= 80) {
					current = s.id;
				}
			}

			activeSection.value = current;
		};

		const jumpTo = (id: string) => {
			const root = windowEl.value;
			const el = document.getElementById("section-" + id);

			if (!root || !el) {
				return;
			}

			activeSection.value = id;
			// Smooth scrolling fires scroll events; don't let them move the mark
			jumpingUntil = Date.now() + 800;
			root.scrollTo({
				top:
					root.scrollTop +
					el.getBoundingClientRect().top -
					root.getBoundingClientRect().top -
					10,
				behavior: "smooth",
			});
		};

		onMounted(() => {
			windowEl.value?.addEventListener("scroll", updateActiveSection, {passive: true});
		});

		onBeforeUnmount(() => {
			windowEl.value?.removeEventListener("scroll", updateActiveSection);
		});

		watch(displayPasswordField, (newValue) => {
			if (newValue) {
				void nextTick(() => {
					publicPassword.value?.focus();
				});
			}
		});

		const commandsInput = ref<HTMLInputElement | null>(null);

		const resizeCommandsInput = () => {
			if (!commandsInput.value) {
				return;
			}

			// Reset height first so it can down size
			commandsInput.value.style.height = "";

			// 2 pixels to account for the border
			commandsInput.value.style.height = `${Math.ceil(
				commandsInput.value.scrollHeight + 2
			)}px`;
		};

		watch(
			() => props.defaults?.commands,
			() => {
				void nextTick(() => {
					resizeCommandsInput();
				});
			}
		);

		watch(
			() => props.defaults?.tls,
			(isSecureChecked) => {
				const ports = [6667, 6697];
				const newPort = isSecureChecked ? 0 : 1;

				// If you disable TLS and current port is 6697,
				// set it to 6667, and vice versa
				if (props.defaults?.port === ports[newPort]) {
					props.defaults.port = ports[1 - newPort];
				}
			}
		);

		const setSaslAuth = (type: string) => {
			if (props.defaults) {
				props.defaults.sasl = type;
			}
		};

		const usernameInput = ref<HTMLInputElement | null>(null);

		const onNickChanged = (event: Event) => {
			if (!usernameInput.value) {
				return;
			}

			const usernameRef = usernameInput.value;

			if (!usernameRef.value || usernameRef.value === previousUsername.value) {
				usernameRef.value = (event.target as HTMLInputElement)?.value;
			}

			previousUsername.value = (event.target as HTMLInputElement)?.value;
		};

		const onSubmit = (event: Event) => {
			const formData = new FormData(event.target as HTMLFormElement);
			const data: Partial<ClientNetwork> = {};

			formData.forEach((value, key) => {
				data[key] = value;
			});

			props.handleSubmit(data as ClientNetwork);
		};

		return {
			store,
			config,
			sectioned,
			sections,
			heading,
			sectionAttrs,
			windowEl,
			activeSection,
			jumpTo,
			globalHighlights,
			displayPasswordField,
			publicPassword,
			commandsInput,
			resizeCommandsInput,
			setSaslAuth,
			usernameInput,
			onNickChanged,
			onSubmit,
		};
	},
});
</script>
