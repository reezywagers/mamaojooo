(() => {
    const PLUGIN_NAME = "Reezy Mass DM";
    const MAX_TARGETS = 100;

    let unregisterBulk = null;
    let unregisterSpoofer = null;
    let unregisterClear = null;
    let unregisterRoleSwap = null;
    let unregisterClearRoleSwap = null;

    const storage = (() => {
        try {
            const created = vendetta?.plugin?.createStorage?.();
            if (created && typeof created === "object") return created;
        } catch {}

        try {
            const legacy = vendetta?.plugin?.storage;
            if (legacy && typeof legacy === "object") return legacy;
        } catch {}

        return {};
    })();

    if (!Array.isArray(storage.spoofDMs)) storage.spoofDMs = [];
    if (!Array.isArray(storage.roleSwaps)) storage.roleSwaps = [];
    if (typeof storage.spooferScript !== "string" || !storage.spooferScript.trim()) storage.spooferScript = "Hey! I saw you in [Server], wanted to reach out!";

    function getArg(args, name) {
        const item = Array.isArray(args) ? args.find(x => x?.name === name) : null;
        return item?.value ?? "";
    }

    function parseIds(input) {
        const ids = [];
        const seen = new Set();

        for (const token of String(input ?? "").split(/[\s,;]+/g)) {
            const match = token.match(/\d{17,20}/);
            if (!match) continue;
            const id = match[0];
            if (!seen.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        }
        return ids;
    }

    function parseTargetPairs(input) {
        const text = String(input ?? "").trim();
        const matches = [...text.matchAll(/\d{17,20}/g)];
        const pairs = [];
        const seen = new Set();
        for (let i = 0; i < matches.length; i++) {
            const userId = matches[i][0];
            if (seen.has(userId)) continue;
            seen.add(userId);
            const start = matches[i].index + userId.length;
            const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
            const serverName = text.slice(start, end).trim().replace(/^[,;|]+|[,;|]+$/g, "").trim();
            pairs.push({ userId, serverName: serverName || "Server" });
        }
        return pairs;
    }

    function applyServerPlaceholder(script, serverName) {
        return String(script ?? "").replace(/\[Server\]/gi, String(serverName || "Server"));
    }

    function toast(message) {
        try {
            const t = vendetta?.ui?.toasts;
            const a = vendetta?.ui?.assets;
            if (t?.showToast) {
                const icon =
                    a?.getAssetIDByName?.("ic_message") ??
                    a?.getAssetIDByName?.("Small");
                t.showToast(String(message), icon);
                return;
            }
        } catch {}
        try { vendetta?.logger?.log?.(`[${PLUGIN_NAME}] ${message}`); } catch {}
    }

    function modules() {
        const metro = vendetta?.metro;
        if (!metro?.findByProps) throw new Error("Kettu Metro API unavailable.");

        const Dispatcher = metro.findByProps("dispatch", "subscribe");
        const UserStore = metro.findByProps("getUser", "getCurrentUser");
        const ChannelStore =
            metro.findByProps("getDMChannelFromUserId", "getDMFromUserId") ||
            metro.findByProps("getChannel", "getDMFromUserId") ||
            metro.findByProps("getDMFromUserId");

        const GuildMemberStore =
            metro.findByProps("getMember", "getMembers") ||
            metro.findByProps("getMember");

        const GuildStore =
            metro.findByProps("getGuilds", "getGuild") ||
            metro.findByProps("getGuild");

        if (!Dispatcher?.dispatch) throw new Error("Could not find Flux dispatcher.");
        if (!UserStore?.getUser) throw new Error("Could not find UserStore.");
        if (!ChannelStore?.getDMFromUserId && !ChannelStore?.getDMChannelFromUserId) throw new Error("Could not find ChannelStore.");
        return {
            Dispatcher,
            UserStore,
            ChannelStore,
            GuildMemberStore,
            GuildStore
        };
    }

    function fakeSnowflakeFromTimestamp(timestampMs, offset = 0) {
        const EPOCH = 1420070400000n;
        const safeMs = Math.max(Number(timestampMs) + offset, Number(EPOCH) + 1);
        const ms = BigInt(Math.floor(safeMs));
        const rand = BigInt(Math.floor(Math.random() * 4194303));
        return String(((ms - EPOCH) << 22n) | rand);
    }

    function resolveRealUser(UserStore, GuildMemberStore, GuildStore, userId) {
        try {
            const direct = UserStore?.getUser?.(userId);
            if (direct?.id) return direct;
        } catch {}

        const guildIds = new Set();
        try {
            const guilds = GuildStore?.getGuilds?.();
            if (guilds && typeof guilds === "object") {
                for (const [id, guild] of Object.entries(guilds)) {
                    if (guild?.id || /^\d{17,20}$/.test(id)) guildIds.add(String(guild?.id || id));
                }
            }
        } catch {}
        try {
            const all = GuildMemberStore?.getMembers?.();
            if (all && typeof all === "object") {
                for (const [guildId] of Object.entries(all)) {
                    if (/^\d{17,20}$/.test(String(guildId))) guildIds.add(String(guildId));
                }
            }
        } catch {}

        for (const guildId of guildIds) {
            try {
                const member = GuildMemberStore?.getMember?.(guildId, userId);
                const user = member?.user ?? member?.userObject;
                if (user?.id) return user;
            } catch {}
        }
        return null;
    }

    function parseTimestamp(dateInput, timeInput) {
        const date = String(dateInput ?? "").trim();
        const time = String(timeInput ?? "").trim();

        if (!date && !time) return new Date();

        const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (date && !dateMatch) {
            throw new Error("Date must be YYYY-MM-DD.");
        }

        const timeMatch = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (time && !timeMatch) {
            throw new Error("Time must be HH:MM or HH:MM:SS.");
        }

        const now = new Date();

        const year = dateMatch ? Number(dateMatch[1]) : now.getFullYear();
        const month = dateMatch ? Number(dateMatch[2]) - 1 : now.getMonth();
        const day = dateMatch ? Number(dateMatch[3]) : now.getDate();

        const hour = timeMatch ? Number(timeMatch[1]) : now.getHours();
        const minute = timeMatch ? Number(timeMatch[2]) : now.getMinutes();
        const second = timeMatch && timeMatch[3] ? Number(timeMatch[3]) : 0;

        if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
            throw new Error("Invalid time.");
        }

        const result = new Date(year, month, day, hour, minute, second, 0);

        if (
            result.getFullYear() !== year ||
            result.getMonth() !== month ||
            result.getDate() !== day
        ) {
            throw new Error("Invalid calendar date.");
        }

        return result;
    }

    function buildDmChannel(user, channelId, lastMessageId) {
        return {
            id: channelId,
            type: 1,
            flags: 0,
            recipients: [user],
            recipient_ids: [user.id],
            last_message_id: lastMessageId,
            is_spam: false,
            owner_id: null,
            name: null,
            icon: null
        };
    }

    function installIntoMutablePrivateChannels(ChannelStore, channel) {
        // Crash-safe: never mutate Discord internal channel collections directly.
        return false;
    }

    function createLocalDm(Dispatcher, ChannelStore, user, channelId, lastMessageId) {
        const channel = buildDmChannel(user, channelId, lastMessageId);
        Dispatcher.dispatch({ type: "CHANNEL_CREATE", channel });
        return channelId;
    }

    function dispatchFakeIncoming(Dispatcher, record) {
        Dispatcher.dispatch({
            type: "MESSAGE_CREATE",
            message: {
                id: record.messageId,
                type: 0,
                channel_id: record.channelId,
                author: record.user,
                content: record.content,
                timestamp: record.timestamp,
                edited_timestamp: null,
                tts: false,
                mention_everyone: false,
                mentions: [],
                mention_roles: [],
                mention_channels: [],
                attachments: [],
                embeds: [],
                reactions: [],
                pinned: false,
                flags: 0,
                components: [],
                sticker_items: []
            },
            channelId: record.channelId,
            optimistic: false
        });
    }

    function replayRecord(record) {
        const { Dispatcher, ChannelStore } = modules();
        createLocalDm(Dispatcher, ChannelStore, record.user, record.channelId, record.messageId);
        dispatchFakeIncoming(Dispatcher, record);
    }

    function saveRecord(record) {
        const existing = storage.spoofDMs.findIndex(x => x.userId === record.userId);
        if (existing >= 0) storage.spoofDMs[existing] = record;
        else storage.spoofDMs.push(record);
    }



    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }


    function getCurrentChatContext() {
        try {
            const metro = vendetta?.metro;
            const SelectedChannelStore =
                metro?.findByProps?.("getChannelId", "getLastSelectedChannelId") ||
                metro?.findByProps?.("getChannelId");
            const ChannelStore =
                metro?.findByProps?.("getChannel", "getDMFromUserId") ||
                metro?.findByProps?.("getDMChannelFromUserId", "getDMFromUserId");
            const channelId = SelectedChannelStore?.getChannelId?.() || SelectedChannelStore?.getLastSelectedChannelId?.();
            const channel = channelId ? ChannelStore?.getChannel?.(channelId) : null;
            if (!channel) return {};

            const GuildStore = metro?.findByProps?.("getGuilds", "getGuild");
            const guildId = channel.guild_id || channel.guildId || null;
            const guild = guildId ? GuildStore?.getGuild?.(guildId) : null;
            let userId = null;
            if (Array.isArray(channel.recipients)) {
                userId = channel.recipients.find(x => x?.id)?.id || null;
            }
            if (!userId && Array.isArray(channel.recipient_ids)) {
                userId = channel.recipient_ids.find(Boolean) || null;
            }
            return {
                channelId,
                guildId,
                guildName: guild?.name || null,
                userId
            };
        } catch {
            return {};
        }
    }

    function getGuildChoices() {
        try {
            const GuildStore = vendetta?.metro?.findByProps?.("getGuilds", "getGuild");
            const guilds = GuildStore?.getGuilds?.() || {};
            return Object.values(guilds)
                .filter(g => g?.id && g?.name)
                .sort((a, b) => String(a.name).localeCompare(String(b.name)))
                .slice(0, 100);
        } catch {
            return [];
        }
    }

    function openSpooferPanel() {
        const ui = vendetta?.ui;
        const React = vendetta?.metro?.common?.React;
        const RN = vendetta?.metro?.common?.ReactNative;
        const showCustomAlert = ui?.alerts?.showCustomAlert;

        if (!React || !RN || !showCustomAlert) {
            try {
                ui?.alerts?.showInputAlert?.({
                    title: "Local Message Spoofer",
                    confirmText: "Save",
                    cancelText: "Cancel",
                    initialValue: storage.spooferScript,
                    placeholder: "Message text; use [Server]",
                    onConfirm: value => {
                        const text = String(value || "").trim();
                        if (text) {
                            storage.spooferScript = text;
                            toast("Spoofer script saved.");
                        }
                    }
                });
            } catch {
                toast("Spoofer panel is unavailable in this Kettu build.");
            }
            return;
        }

        const { useState } = React;
        const { View, Text, TextInput, ScrollView, Pressable, Switch } = RN;
        const ctx = getCurrentChatContext();

        const Panel = () => {
            const [userId, setUserId] = useState(ctx.userId || "");
            const [message, setMessage] = useState(storage.spooferScript || "Hey! I saw you in [Server], wanted to reach out!");
            const [serverId, setServerId] = useState(ctx.guildId || "");
            const [serverName, setServerName] = useState(ctx.guildName || "");
            const [linkPreviews, setLinkPreviews] = useState(true);
            const [year, setYear] = useState(String(new Date().getFullYear()));
            const [month, setMonth] = useState(String(new Date().getMonth() + 1));
            const [day, setDay] = useState(String(new Date().getDate()));
            const [hour, setHour] = useState(String(new Date().getHours()));
            const [minute, setMinute] = useState(String(new Date().getMinutes()));
            const [conversation, setConversation] = useState("");

            const inputStyle = {
                backgroundColor: "#23232d",
                color: "#f2f3f5",
                borderRadius: 8,
                paddingHorizontal: 14,
                paddingVertical: 11,
                marginTop: 8,
                marginBottom: 12,
                fontSize: 16
            };
            const labelStyle = { color: "#f2f3f5", fontSize: 16, marginTop: 12 };
            const helpStyle = { color: "#b5bac1", fontSize: 13, marginTop: 4, lineHeight: 18 };
            const buttonStyle = {
                backgroundColor: "#2b2d31",
                borderRadius: 8,
                padding: 13,
                marginTop: 8
            };
            const buttonText = { color: "#f2f3f5", fontSize: 16, fontWeight: "600" };

            const saveScript = () => {
                const text = String(message || "").trim();
                if (!text) return toast("Spoofer: enter a message first.");
                storage.spooferScript = text;
                toast("Spoofer script saved.");
            };

            const fillCurrent = () => {
                const now = getCurrentChatContext();
                if (now.userId) setUserId(now.userId);
                if (now.guildId) setServerId(now.guildId);
                if (now.guildName) setServerName(now.guildName);
                toast(now.userId ? "Filled from current chat." : "No other user found in this chat.");
            };

            const pickServer = () => {
                const choices = getGuildChoices();
                if (!choices.length) return toast("No cached servers found.");
                try {
                    ui.alerts.showConfirmationAlert?.({
                        title: "Pick from my servers",
                        content: choices.slice(0, 20).map(g => `${g.name} — ${g.id}`).join("\\n\\n"),
                        confirmText: "Use first shown",
                        cancelText: "Cancel",
                        onConfirm: () => {
                            const g = choices[0];
                            if (g) {
                                setServerId(g.id);
                                setServerName(g.name);
                            }
                        }
                    });
                } catch {
                    const first = choices[0];
                    setServerId(first.id);
                    setServerName(first.name);
                }
            };

            const resolvedServer = serverName || serverId || "(no match - enter a server ID or use the current server)";

            const sendOne = async () => {
                const id = String(userId || "").trim();
                if (!/^\d{17,20}$/.test(id)) return toast("Spoofer: enter a valid User ID.");
                const text = String(message || "").trim();
                if (!text) return toast("Spoofer: enter a message.");

                try {
                    const { Dispatcher, UserStore, GuildMemberStore, GuildStore, ChannelStore } = modules();
                    const user = resolveRealUser(UserStore, GuildMemberStore, GuildStore, id);
                    if (!user) throw new Error("Could not resolve that user's cached profile.");
                    const channelId = await openLocalDm(Dispatcher, ChannelStore, user, id);
                    const stamp = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0);
                    const record = {
                        userId: id,
                        user,
                        channelId,
                        messageId: fakeSnowflakeFromTimestamp(stamp.getTime(), Math.floor(Math.random() * 100000)),
                        content: applyServerPlaceholder(text, resolvedServer),
                        timestamp: stamp.toISOString(),
                        realDm: false,
                        serverName: resolvedServer,
                        linkPreviews: !!linkPreviews
                    };
                    dispatchFakeIncoming(Dispatcher, record);
                    saveRecord(record);
                    storage.spooferScript = text;
                    toast(`Fake message from ${user.username || user.global_name || id} created locally.`);
                } catch (err) {
                    toast(`Spoofer error: ${err?.message || String(err)}`);
                }
            };

            const buildConversation = () => {
                const lines = String(conversation || "").split(/\\n+/).map(x => x.trim()).filter(Boolean);
                if (!lines.length) return toast("Conversation Builder: enter at least one line.");
                const built = lines.map(line => {
                    const m = line.match(/^([^\\[]+)?\\s*\\[(\\d{1,2}:\\d{2})\\]\\s*-\\s*(.*)$/);
                    if (!m) return line.replace(/^['\"]|['\"]$/g, "");
                    return m[3];
                }).join("\\n");
                setMessage(built);
                storage.spooferScript = built;
                toast(`${lines.length} conversation line${lines.length === 1 ? "" : "s"} loaded.`);
            };

            return React.createElement(View, { style: { backgroundColor: "#1e1f24", borderRadius: 16, overflow: "hidden", maxHeight: "92%" } },
                React.createElement(View, { style: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center" } },
                    React.createElement(Text, { style: { color: "#f2f3f5", fontSize: 18, fontWeight: "700" } }, "Local Message Spoofer"),
                    React.createElement(Text, { style: { color: "#b5bac1", fontSize: 14 } }, "LOCAL ONLY")
                ),
                React.createElement(ScrollView, { keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 20, paddingTop: 6 } },
                    React.createElement(Text, { style: { color: "#b5bac1", fontSize: 13, fontWeight: "700", marginTop: 8 } }, "FAKE MESSAGE"),
                    React.createElement(Text, { style: labelStyle }, "User ID (Optional)"),
                    React.createElement(TextInput, { value: userId, onChangeText: setUserId, placeholder: "User ID", placeholderTextColor: "#6d6f78", style: inputStyle, keyboardType: "number-pad" }),
                    React.createElement(Pressable, { style: buttonStyle, onPress: fillCurrent },
                        React.createElement(Text, { style: buttonText }, "Fill from current chat")
                    ),
                    React.createElement(Text, { style: labelStyle }, "Message"),
                    React.createElement(TextInput, { value: message, onChangeText: setMessage, placeholder: "Enter message content", placeholderTextColor: "#6d6f78", style: [inputStyle, { minHeight: 90, textAlignVertical: "top" }], multiline: true }),
                    React.createElement(Text, { style: labelStyle }, "Server ID for [server] tag (optional)"),
                    React.createElement(TextInput, { value: serverId, onChangeText: setServerId, placeholder: "Paste a server ID", placeholderTextColor: "#6d6f78", style: inputStyle, keyboardType: "number-pad" }),
                    React.createElement(Text, { style: { color: "#f2f3f5", fontSize: 14, marginTop: 4 } }, `[Server] = ${resolvedServer}`),
                    React.createElement(Text, { style: helpStyle }, "Type [Server] in your message and it is replaced with the server name for the fake message."),
                    React.createElement(Pressable, { style: buttonStyle, onPress: () => {
                        const choices = getGuildChoices();
                        const match = choices.find(g => g.id === serverId);
                        if (match) setServerName(match.name);
                        else if (serverId) toast("No cached server with that ID.");
                    } }, React.createElement(Text, { style: buttonText }, "Resolve server name")),
                    React.createElement(Pressable, { style: buttonStyle, onPress: () => {
                        const now = getCurrentChatContext();
                        if (now.guildId) { setServerId(now.guildId); setServerName(now.guildName || ""); }
                        else toast("Current channel is not inside a server.");
                    } }, React.createElement(Text, { style: buttonText }, "Use the server I'm in now")),
                    React.createElement(Pressable, { style: buttonStyle, onPress: pickServer }, React.createElement(Text, { style: buttonText }, "Pick from my servers")),
                    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12 } },
                        React.createElement(View, null,
                            React.createElement(Text, { style: labelStyle }, "Link Previews"),
                            React.createElement(Text, { style: helpStyle }, "Keep the setting used by the spoofer.")),
                        React.createElement(Switch, { value: linkPreviews, onValueChange: setLinkPreviews })
                    ),
                    React.createElement(Text, { style: { color: "#b5bac1", fontSize: 13, fontWeight: "700", marginTop: 12 } }, "CUSTOM TIMESTAMP"),
                    ...[["Year", year, setYear], ["Month", month, setMonth], ["Day", day, setDay], ["Hour", hour, setHour], ["Minute", minute, setMinute]].map(([label, value, setter]) =>
                        React.createElement(View, { key: label },
                            React.createElement(Text, { style: labelStyle }, label),
                            React.createElement(TextInput, { value, onChangeText: setter, style: inputStyle, keyboardType: "number-pad" })
                        )
                    ),
                    React.createElement(Pressable, { style: { backgroundColor: "#5865f2", borderRadius: 8, padding: 14, marginTop: 8 }, onPress: sendOne },
                        React.createElement(Text, { style: { color: "white", textAlign: "center", fontSize: 16, fontWeight: "700" } }, "Send Fake Message")
                    ),
                    React.createElement(Text, { style: { color: "#b5bac1", fontSize: 12, marginTop: 7 } }, "This never calls Discord's real message-send endpoint."),
                    React.createElement(Text, { style: { color: "#b5bac1", fontSize: 13, fontWeight: "700", marginTop: 24 } }, "CONVERSATION BUILDER"),
                    React.createElement(TextInput, { value: conversation, onChangeText: setConversation, placeholder: "them [07:24] - Hey...", placeholderTextColor: "#6d6f78", style: [inputStyle, { minHeight: 120, textAlignVertical: "top" }], multiline: true }),
                    React.createElement(Text, { style: helpStyle }, "Format: userId [time] - message. Use 'me' for your own line. The built text becomes the saved /sdm spoofer script."),
                    React.createElement(Pressable, { style: buttonStyle, onPress: buildConversation }, React.createElement(Text, { style: buttonText }, "Build Conversation")),
                    React.createElement(Pressable, { style: { backgroundColor: "#2b2d31", borderRadius: 8, padding: 14, marginTop: 10, marginBottom: 24 }, onPress: saveScript }, React.createElement(Text, { style: { color: "#f2f3f5", textAlign: "center", fontSize: 16, fontWeight: "700" } }, "Save Spoofer Script"))
                )
            );
        };

        try {
            showCustomAlert(Panel, {});
        } catch (err) {
            toast(`Could not open spoofer panel: ${err?.message || String(err)}`);
        }
    }

    function getDmChannelId(ChannelStore, userId) {
        try {
            const id = ChannelStore.getDMFromUserId(userId);
            if (typeof id === "string") return id;
            if (id?.id) return id.id;
        } catch {}

        try {
            const channel = ChannelStore.getDMChannelFromUserId?.(userId);
            if (channel?.id) return channel.id;
        } catch {}

        return null;
    }

    async function waitForDmChannel(ChannelStore, userId, timeoutMs = 5000) {
        const started = Date.now();

        while (Date.now() - started < timeoutMs) {
            const id = getDmChannelId(ChannelStore, userId);
            if (id) return id;
            await sleep(100);
        }

        return null;
    }

    async function openLocalDm(Dispatcher, ChannelStore, user, userId) {
        const existing = getDmChannelId(ChannelStore, userId);
        if (existing) return existing;

        const channelId = fakeSnowflakeFromTimestamp(
            Date.now(),
            Math.floor(Math.random() * 100000)
        );
        createLocalDm(Dispatcher, ChannelStore, user, channelId, channelId);

        const appeared = await waitForDmChannel(ChannelStore, userId, 1000);
        return appeared || channelId;
    }

    function roleModules() {
        const metro = vendetta?.metro;
        if (!metro?.findByProps) throw new Error("Kettu Metro API unavailable.");

        const Dispatcher = metro.findByProps("dispatch", "subscribe");
        const UserStore = metro.findByProps("getUser", "getCurrentUser");
        const GuildMemberStore =
            metro.findByProps("getMember", "getMembers") ||
            metro.findByProps("getMember");

        if (!Dispatcher?.dispatch) throw new Error("Could not find Flux dispatcher.");
        if (!UserStore?.getUser) throw new Error("Could not find UserStore.");
        if (!GuildMemberStore?.getMember) throw new Error("Could not find GuildMemberStore.");

        return { Dispatcher, UserStore, GuildMemberStore };
    }

    function getMember(GuildMemberStore, guildId, userId) {
        try {
            return GuildMemberStore.getMember(guildId, userId);
        } catch {
            return null;
        }
    }

    function dispatchLocalMemberUpdate(Dispatcher, guildId, user, memberLike) {
        Dispatcher.dispatch({
            type: "GUILD_MEMBER_UPDATE",
            guildId,
            guild_id: guildId,
            user,
            roles: Array.isArray(memberLike?.roles) ? [...memberLike.roles] : [],
            nick: memberLike?.nick ?? null,
            avatar: memberLike?.avatar ?? null,
            communication_disabled_until: memberLike?.communication_disabled_until ?? null,
            premium_since: memberLike?.premium_since ?? null,
            pending: Boolean(memberLike?.pending),
            joined_at: memberLike?.joined_at ?? new Date().toISOString(),
            flags: memberLike?.flags ?? 0
        });
    }

    function saveRoleSwap(record) {
        const index = storage.roleSwaps.findIndex(
            x => x.guildId === record.guildId && x.myUserId === record.myUserId
        );

        if (index >= 0) storage.roleSwaps[index] = record;
        else storage.roleSwaps.push(record);
    }

    async function roleSwapExecute(args) {
        const myUserId = String(getArg(args, "my-id") ?? "").match(/\d{17,20}/)?.[0];
        const targetUserId = String(getArg(args, "target-id") ?? "").match(/\d{17,20}/)?.[0];
        const guildId = String(getArg(args, "server-id") ?? "").match(/\d{17,20}/)?.[0];

        if (!myUserId || !targetUserId || !guildId) {
            toast("Role Swap: enter valid my-id, target-id and server-id.");
            return;
        }

        try {
            const { Dispatcher, UserStore, GuildMemberStore } = roleModules();

            const me = UserStore.getUser(myUserId);
            const myMember = getMember(GuildMemberStore, guildId, myUserId);
            const targetMember = getMember(GuildMemberStore, guildId, targetUserId);

            if (!me) throw new Error("Your user is not cached.");
            if (!myMember) throw new Error("Your server member profile is not cached.");
            if (!targetMember) throw new Error("Target member is not cached in that server.");

            const original = {
                roles: Array.isArray(myMember.roles) ? [...myMember.roles] : [],
                nick: myMember.nick ?? null,
                avatar: myMember.avatar ?? null,
                communication_disabled_until: myMember.communication_disabled_until ?? null,
                premium_since: myMember.premium_since ?? null,
                pending: Boolean(myMember.pending),
                joined_at: myMember.joined_at ?? null,
                flags: myMember.flags ?? 0
            };

            const spoofed = {
                roles: Array.isArray(targetMember.roles) ? [...targetMember.roles] : [],
                // Keep YOUR visible profile identity; only copy server roles.
                nick: myMember.nick ?? null,
                avatar: myMember.avatar ?? null,
                communication_disabled_until: myMember.communication_disabled_until ?? null,
                premium_since: myMember.premium_since ?? null,
                pending: Boolean(myMember.pending),
                joined_at: myMember.joined_at ?? null,
                flags: myMember.flags ?? 0
            };

            dispatchLocalMemberUpdate(Dispatcher, guildId, me, spoofed);

            saveRoleSwap({
                guildId,
                myUserId,
                targetUserId,
                original,
                spoofed
            });

            toast(`Role Swap: locally copied ${spoofed.roles.length} role${spoofed.roles.length === 1 ? "" : "s"}.`);
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] role-swap`, err); } catch {}
            toast(`Role Swap error: ${err?.message || String(err)}`);
        }
    }

    async function clearRoleSwapExecute(args) {
        const myUserId = String(getArg(args, "my-id") ?? "").match(/\d{17,20}/)?.[0];
        const guildId = String(getArg(args, "server-id") ?? "").match(/\d{17,20}/)?.[0];

        if (!myUserId || !guildId) {
            toast("Clear Role Swap: enter valid my-id and server-id.");
            return;
        }

        try {
            const { Dispatcher, UserStore } = roleModules();
            const me = UserStore.getUser(myUserId);
            if (!me) throw new Error("Your user is not cached.");

            const index = storage.roleSwaps.findIndex(
                x => x.guildId === guildId && x.myUserId === myUserId
            );

            if (index < 0) {
                toast("Clear Role Swap: no saved spoof for that server.");
                return;
            }

            const record = storage.roleSwaps[index];
            dispatchLocalMemberUpdate(Dispatcher, guildId, me, record.original);
            storage.roleSwaps.splice(index, 1);

            toast("Clear Role Swap: restored your original local roles.");
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] clear-role-swap`, err); } catch {}
            toast(`Clear Role Swap error: ${err?.message || String(err)}`);
        }
    }

    function restoreRoleSwaps() {
        if (!storage.roleSwaps.length) return;

        setTimeout(() => {
            try {
                const { Dispatcher, UserStore } = roleModules();

                for (const record of storage.roleSwaps) {
                    try {
                        const me = UserStore.getUser(record.myUserId);
                        if (!me) continue;
                        dispatchLocalMemberUpdate(
                            Dispatcher,
                            record.guildId,
                            me,
                            record.spoofed
                        );
                    } catch {}
                }
            } catch {}
        }, 1800);
    }

    async function bulkExecute(args) {
        const pairs = parseTargetPairs(getArg(args, "targets"));
        const dateInput = getArg(args, "date");
        const timeInput = getArg(args, "time");

        if (!pairs.length) {
            toast("Reezy Mass DM: use ID + server name, e.g. 123456789 Minecraft");
            return;
        }
        if (pairs.length > 50) {
            toast("Reezy Mass DM: max 50 targets per run.");
            return;
        }

        try {
            const baseTimestamp = parseTimestamp(dateInput, timeInput);
            const baseMs = baseTimestamp.getTime();
            const { Dispatcher, UserStore, ChannelStore, GuildMemberStore, GuildStore } = modules();
            const script = String(storage.spooferScript || "").trim();

            if (!script) {
                toast("Reezy Mass DM: set a script with /spoofer first.");
                return;
            }

            let injected = 0;
            let failed = 0;

            for (let i = 0; i < pairs.length; i++) {
                const { userId, serverName } = pairs[i];
                try {
                    const user = resolveRealUser(UserStore, GuildMemberStore, GuildStore, userId);
                    if (!user) throw new Error(`Could not resolve real profile for ${userId}.`);

                    const channelId = await openLocalDm(Dispatcher, ChannelStore, user, userId);
                    const record = {
                        userId,
                        user,
                        channelId,
                        messageId: fakeSnowflakeFromTimestamp(baseMs, i),
                        content: applyServerPlaceholder(script, serverName),
                        timestamp: new Date(baseMs + i).toISOString(),
                        realDm: false,
                        serverName
                    };

                    dispatchFakeIncoming(Dispatcher, record);
                    saveRecord(record);
                    injected++;
                } catch (err) {
                    failed++;
                    try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] ${userId}`, err); } catch {}
                }

                if (i < pairs.length - 1) await sleep(2500);
            }

            toast(`Reezy Mass DM: ${injected}/${pairs.length} injected` +
                (failed ? ` • ${failed} failed` : "") + " • local-only");
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}]`, err); } catch {}
            toast(`Reezy Mass DM error: ${err?.message || String(err)}`);
        }
    }

    async function clearExecute(args) {
        const raw = String(getArg(args, "targets") ?? "").trim();
        const ids = parseIds(raw);

        try {
            const { Dispatcher } = modules();
            let toClear;

            if (!raw || raw.toLowerCase() === "all") {
                toClear = [...storage.spoofDMs];
                storage.spoofDMs.splice(0, storage.spoofDMs.length);
            } else {
                const set = new Set(ids);
                toClear = storage.spoofDMs.filter(x => set.has(x.userId));
                const keep = storage.spoofDMs.filter(x => !set.has(x.userId));
                storage.spoofDMs.splice(0, storage.spoofDMs.length, ...keep);
            }

            for (const record of toClear) {
                try {
                    Dispatcher.dispatch({
                        type: "MESSAGE_DELETE",
                        channelId: record.channelId,
                        id: record.messageId
                    });
                } catch {}
            }

            toast(`Clear DM: removed ${toClear.length} local fake message${toClear.length === 1 ? "" : "s"}.`);
        } catch (err) {
            try { vendetta?.logger?.error?.(`[${PLUGIN_NAME}] clear`, err); } catch {}
            toast(`Clear DM error: ${err?.message || String(err)}`);
        }
    }

    function restorePersistentDMs() {
        // Stable build: no synthetic message replay while Kettu is starting.
        return;
    }

    return {
        onLoad() {
            unregisterBulk = vendetta.commands.registerCommand({
                name: "sdm",
                displayName: "sdm",
                description: "Receive local fake DMs from multiple user IDs",
                displayDescription: "Receive local fake DMs from multiple user IDs",
                options: [
                    {
                        name: "targets",
                        displayName: "targets",
                        description: "ID + server name pairs, e.g. 123456789 Minecraft 987654321 Cool Server",
                        displayDescription: "ID + server name pairs",
                        type: 3,
                        required: true
                    },
                    {
                        name: "date",
                        displayName: "date",
                        description: "Fake DM date: YYYY-MM-DD (optional)",
                        displayDescription: "Fake DM date: YYYY-MM-DD (optional)",
                        type: 3,
                        required: false
                    },
                    {
                        name: "time",
                        displayName: "time",
                        description: "Fake DM time: HH:MM or HH:MM:SS (optional)",
                        displayDescription: "Fake DM time: HH:MM or HH:MM:SS",
                        type: 3,
                        required: false
                    }
                ],
                execute: bulkExecute
            });

            unregisterSpoofer = vendetta.commands.registerCommand({
                name: "spoofer",
                displayName: "spoofer",
                description: "Open the Local Message Spoofer panel.",
                displayDescription: "Open the Local Message Spoofer panel.",
                options: [
                    {
                        name: "script",
                        displayName: "script",
                        description: "Script text. [Server] is replaced per target.",
                        displayDescription: "Script text. [Server] is replaced per target.",
                        type: 3,
                        required: false
                    }
                ],
                execute: () => {
                    openSpooferPanel();
                }
            });

            unregisterClear = vendetta.commands.registerCommand({
                name: "clear-dm",
                displayName: "clear-dm",
                description: "Clear spoofed DMs created by Reezy Mass DM",
                displayDescription: "Clear spoofed DMs created by Reezy Mass DM",
                options: [
                    {
                        name: "targets",
                        displayName: "targets",
                        description: 'User IDs to clear, or type "all"',
                        displayDescription: 'User IDs to clear, or type "all"',
                        type: 3,
                        required: false
                    }
                ],
                execute: clearExecute
            });

            unregisterRoleSwap = vendetta.commands.registerCommand({
                name: "role-swap",
                displayName: "role-swap",
                description: "Locally show your profile with another member's server roles",
                displayDescription: "Locally show your profile with another member's server roles",
                options: [
                    {
                        name: "my-id",
                        displayName: "my-id",
                        description: "Your Discord user ID",
                        displayDescription: "Your Discord user ID",
                        type: 3,
                        required: true
                    },
                    {
                        name: "target-id",
                        displayName: "target-id",
                        description: "Member whose roles should be copied locally",
                        displayDescription: "Member whose roles should be copied locally",
                        type: 3,
                        required: true
                    },
                    {
                        name: "server-id",
                        displayName: "server-id",
                        description: "Server ID",
                        displayDescription: "Server ID",
                        type: 3,
                        required: true
                    }
                ],
                execute: roleSwapExecute
            });

            unregisterClearRoleSwap = vendetta.commands.registerCommand({
                name: "clear-role-swap",
                displayName: "clear-role-swap",
                description: "Restore your original locally displayed server roles",
                displayDescription: "Restore your original locally displayed server roles",
                options: [
                    {
                        name: "my-id",
                        displayName: "my-id",
                        description: "Your Discord user ID",
                        displayDescription: "Your Discord user ID",
                        type: 3,
                        required: true
                    },
                    {
                        name: "server-id",
                        displayName: "server-id",
                        description: "Server ID",
                        displayDescription: "Server ID",
                        type: 3,
                        required: true
                    }
                ],
                execute: clearRoleSwapExecute
            });


        },

        onUnload() {
            try { unregisterBulk?.(); } catch {}
            try { unregisterSpoofer?.(); } catch {}
            try { unregisterClear?.(); } catch {}
            try { unregisterRoleSwap?.(); } catch {}
            try { unregisterClearRoleSwap?.(); } catch {}
            unregisterBulk = null;
            unregisterSpoofer = null;
            unregisterClear = null;
            unregisterRoleSwap = null;
            unregisterClearRoleSwap = null;
        }
    };
})
