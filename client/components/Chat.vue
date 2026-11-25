<template>
	<div id="chat-container" class="window" :data-current-channel="channel.name" lang="">
		<div
			id="chat"
			:class="{
				'hide-motd': !store.state.settings.motd,
				'time-seconds': store.state.settings.showSeconds,
				'time-12h': store.state.settings.use12hClock,
				'colored-nicks': true, // TODO temporarily fixes themes, to be removed in next major version
			}"
		>
			<div
				:id="'chan-' + channel.id"
				class="chat-view"
				:data-type="channel.type"
				:aria-label="channel.name"
				role="tabpanel"
			>
				<div
					class="header"
					:data-name="channel.type === 'query' ? channel.name : undefined"
				>
					<SidebarToggle />
					<span
						class="title"
						:class="{'has-details': detailsOn}"
						:aria-label="'Currently open ' + channel.type"
						:role="detailsOn ? 'button' : undefined"
						:tabindex="detailsOn ? 0 : undefined"
						:title="detailsOn ? 'Show details' : undefined"
						@click="detailsOn && openDetails()"
						@keydown.enter="detailsOn && openDetails()"
						>{{ channel.name }}</span
					>
					<ThemeSlot name="chat.header.title" :props="{network, channel}" />
					<button
						v-if="channel.type === 'query' && profilePanelOn"
						type="button"
						class="profile-toggle"
						:aria-pressed="profilePanel.open ? 'true' : 'false'"
						:aria-label="profilePanel.open ? 'Hide profile' : 'Show profile'"
						:title="profilePanel.open ? 'Hide profile' : 'Show profile'"
						@click="toggleProfilePanel"
					/>
					<div v-if="channel.editTopic === true" class="topic-container">
						<input
							ref="topicInput"
							:value="channel.topic"
							class="topic-input"
							placeholder="Set channel topic"
							enterkeyhint="done"
							@keyup.enter="saveTopic"
							@keyup.esc="channel.editTopic = false"
						/>
						<span aria-label="Save topic" class="save-topic" @click="saveTopic">
							<span type="button" aria-label="Save topic"></span>
						</span>
					</div>
					<span
						v-else
						:title="plainTopic"
						:class="{topic: true, empty: !channel.topic}"
						@dblclick="editTopic"
						><ParsedMessage
							v-if="channel.topic"
							:network="network"
							:text="channel.topic"
					/></span>
					<MessageSearchForm
						v-if="
							store.state.settings.searchEnabled &&
							['channel', 'query'].includes(channel.type)
						"
						:network="network"
						:channel="channel"
					/>
					<button
						class="mentions"
						aria-label="Open your mentions"
						@click="openMentions"
					/>
					<button
						class="menu"
						aria-label="Open the context menu"
						@click="openContextMenu"
					/>
					<span
						v-if="channel.type === 'channel'"
						class="rt-tooltip tooltipped tooltipped-w"
						aria-label="Toggle user list"
					>
						<button
							class="rt"
							aria-label="Toggle user list"
							@click="store.commit('toggleUserlist')"
						/>
					</span>
				</div>
				<div v-if="channel.type === 'special'" class="chat-content">
					<div class="chat">
						<div class="messages">
							<div class="msg">
								<component
									:is="specialComponent"
									:network="network"
									:channel="channel"
								/>
							</div>
						</div>
					</div>
				</div>
				<div v-else class="chat-content">
					<button
						:class="[
							'scroll-down tooltipped tooltipped-w tooltipped-no-touch',
							{'scroll-down-shown': !channel.scrolledToBottom},
						]"
						aria-label="Jump to recent messages"
						@click="messageList?.jumpToBottom()"
					>
						<div class="scroll-down-arrow" />
					</button>
					<ChatUserList v-if="channel.type === 'channel'" :channel="channel" />
					<!-- "Profile next to conversations" (the profilePanel feature) -->
					<aside
						v-if="channel.type === 'query' && profilePanelOn && profilePanel.open"
						class="profile-panel"
						aria-label="Profile"
					>
						<ProfileCard :network="network" :channel="channel" :nick="channel.name" />
					</aside>
					<MessageList
						ref="messageList"
						:network="network"
						:channel="channel"
						:is-focused="isFocused"
						:focused-time="focusedTime"
					/>
				</div>
			</div>
		</div>
		<div
			v-if="store.state.currentUserVisibleError"
			id="user-visible-error"
			@click="hideUserVisibleError"
		>
			{{ store.state.currentUserVisibleError }}
		</div>
		<ChatInput :network="network" :channel="channel" />
	</div>
</template>

<script lang="ts">
import socket from "../js/socket";
import eventbus from "../js/eventbus";
import ParsedMessage from "./ParsedMessage.vue";
import MessageList from "./MessageList.vue";
import ChatInput from "./ChatInput.vue";
import ChatUserList from "./ChatUserList.vue";
import SidebarToggle from "./SidebarToggle.vue";
import MessageSearchForm from "./MessageSearchForm.vue";
import ListBans from "./Special/ListBans.vue";
import ListInvites from "./Special/ListInvites.vue";
import ListChannels from "./Special/ListChannels.vue";
import ListIgnored from "./Special/ListIgnored.vue";
import ProfileCard from "./ProfileCard.vue";
import ThemeSlot from "./ThemeSlot.vue";
import {feature} from "../js/features";
import {profilePanel, toggleProfilePanel} from "../js/profiles";
import {navigate} from "../js/router";
import {defineComponent, PropType, ref, computed, watch, nextTick, onMounted, Component} from "vue";
import type {ClientNetwork, ClientChan} from "../js/types";
import {useStore} from "../js/store";
import {SpecialChanType, ChanType} from "../../shared/types/chan";
import parseStyle from "../js/helpers/ircmessageparser/parseStyle";
import topicCommand from "../js/helpers/topicCommand";

export default defineComponent({
	name: "Chat",
	components: {
		ParsedMessage,
		MessageList,
		ChatInput,
		ChatUserList,
		SidebarToggle,
		MessageSearchForm,
		ProfileCard,
		ThemeSlot,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		isFocused: Number,
		focusedTime: Number,
	},
	emits: ["channel-changed"],
	setup(props, {emit}) {
		const store = useStore();

		const messageList = ref<InstanceType<typeof MessageList> | null>(null);
		const topicInput = ref<HTMLInputElement | null>(null);

		const openDetails = () => void navigate("ConversationDetails", {id: props.channel.id});
		const detailsOn = computed(
			() =>
				feature("conversationDetails") &&
				(props.channel.type === ChanType.CHANNEL || props.channel.type === ChanType.QUERY)
		);
		const profilePanelOn = computed(() => feature("profilePanel"));

		const plainTopic = computed(() => {
			const topic = props.channel.topic;

			if (!topic) {
				return "";
			}

			return parseStyle(topic)
				.map((fragment) => fragment.text)
				.join("");
		});

		const specialComponent = computed(() => {
			switch (props.channel.special) {
				case SpecialChanType.BANLIST:
					return ListBans as Component;
				case SpecialChanType.INVITELIST:
					return ListInvites as Component;
				case SpecialChanType.CHANNELLIST:
					return ListChannels as Component;
				case SpecialChanType.IGNORELIST:
					return ListIgnored as Component;
			}

			return undefined;
		});

		const channelChanged = () => {
			// Triggered when active channel is set or changed
			emit("channel-changed", props.channel);

			socket.emit("open", props.channel.id);

			if (props.channel.usersOutdated) {
				props.channel.usersOutdated = false;

				socket.emit("names", {
					target: props.channel.id,
				});
			}
		};

		const hideUserVisibleError = () => {
			store.commit("currentUserVisibleError", null);
		};

		const editTopic = () => {
			if (props.channel.type === ChanType.CHANNEL) {
				props.channel.editTopic = true;
			}
		};

		const saveTopic = () => {
			props.channel.editTopic = false;

			if (!topicInput.value) {
				return;
			}

			const newTopic = topicInput.value.value;

			if (props.channel.topic !== newTopic) {
				const target = props.channel.id;
				const text = topicCommand(newTopic);
				socket.emit("input", {target, text});
			}
		};

		const openContextMenu = (event: MouseEvent) => {
			eventbus.emit("contextmenu:channel", {
				event: event,
				channel: props.channel,
				network: props.network,
			});
		};

		const openMentions = (event: MouseEvent) => {
			eventbus.emit("mentions:toggle", {
				event: event,
			});
		};

		watch(
			() => props.channel,
			() => {
				channelChanged();
			}
		);

		watch(
			() => props.channel.editTopic,
			(newTopic) => {
				if (newTopic) {
					void nextTick(() => {
						topicInput.value?.focus();
					});
				}
			}
		);

		onMounted(() => {
			channelChanged();

			if (props.channel.editTopic) {
				void nextTick(() => {
					topicInput.value?.focus();
				});
			}
		});

		return {
			profilePanel,
			toggleProfilePanel,
			openDetails,
			detailsOn,
			profilePanelOn,
			store,
			messageList,
			topicInput,
			plainTopic,
			specialComponent,
			hideUserVisibleError,
			editTopic,
			saveTopic,
			openContextMenu,
			openMentions,
		};
	},
});
</script>
