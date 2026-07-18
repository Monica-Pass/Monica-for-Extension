<script setup lang="ts">
import { computed, ref } from "vue";
import type { TotpItem } from "../core/model";
import { resolveSteamSellerReceive, type SteamBatchPriceMode } from "../providers/steam/steam-market";
import { vaultClient } from "../runtime/client";
import type { SteamAuthorizedDevice, SteamConfirmation, SteamInventoryOverview, SteamInventoryPage, SteamMarketListingsPage, SteamMarketQuote, SteamMiniProfileBackground, SteamPendingLogin } from "../runtime/messages";
import TotpCodeCell from "./TotpCodeCell.vue";

type SteamTab = "approvals" | "inventory" | "market" | "devices";
type InventoryItem = SteamInventoryPage["items"][number];
type MarketListing = SteamMarketListingsPage["items"][number];

const props = defineProps<{ item: TotpItem; query?: string }>();
const activeTab = ref<SteamTab>("approvals");
const busy = ref("");
const error = ref("");
const notice = ref("");

const confirmations = ref<SteamConfirmation[]>([]);
const pendingLogins = ref<SteamPendingLogin[]>([]);
const approvalsLoaded = ref(false);

const devices = ref<SteamAuthorizedDevice[]>([]);
const devicesLoaded = ref(false);

const inventoryOverview = ref<SteamInventoryOverview>();
const inventoryItems = ref<InventoryItem[]>([]);
const inventoryLoaded = ref(false);
const selectedGameKey = ref("");
const inventoryCursor = ref<string>();
const inventoryHasMore = ref(false);
const selectedAssetIds = ref<string[]>([]);
const quotes = ref<Record<string, SteamMarketQuote>>({});
const priceMode = ref<SteamBatchPriceMode>("lowest-listing");
const manualReceive = ref<number>();
const autoConfirm = ref(false);

const listings = ref<MarketListing[]>([]);
const listingsLoaded = ref(false);
const listingsStart = ref(0);
const listingsHasMore = ref(false);
const selectedListingIds = ref<string[]>([]);
const profileBackground = ref<SteamMiniProfileBackground>();
const profileLoaded = ref(false);

const needle = computed(() => (props.query || "").trim().toLocaleLowerCase());
const selectedGame = computed(() => inventoryOverview.value?.games.find((game) => gameKey(game.appId, game.contextId) === selectedGameKey.value));
const selectedInventoryItems = computed(() => inventoryItems.value.filter((item) => selectedAssetIds.value.includes(item.assetId)));
const filteredConfirmations = computed(() => confirmations.value.filter((entry) => matches(`${entry.headline} ${entry.summary} ${entry.type}`)));
const filteredLogins = computed(() => pendingLogins.value.filter((entry) => matches(`${entry.deviceName} ${entry.ip} ${entry.city} ${entry.country}`)));
const filteredDevices = computed(() => devices.value.filter((entry) => matches(`${entry.description} ${entry.firstSeen?.location || ""} ${entry.lastSeen?.location || ""}`)));
const filteredInventory = computed(() => inventoryItems.value.filter((entry) => matches(`${entry.name} ${entry.marketHashName} ${entry.type}`)));
const filteredListings = computed(() => listings.value.filter((entry) => matches(`${entry.name} ${entry.marketHashName} ${entry.listingId}`)));

function matches(value: string): boolean {
  return !needle.value || value.toLocaleLowerCase().includes(needle.value);
}

function gameKey(appId: number, contextId: string): string {
  return `${appId}:${contextId}`;
}

function selectTab(tab: SteamTab) {
  activeTab.value = tab;
  error.value = "";
  notice.value = "";
  if (tab === "approvals" && !approvalsLoaded.value) void loadApprovals();
  if (tab === "inventory" && !inventoryLoaded.value) void loadInventoryOverview();
  if (tab === "market" && !listingsLoaded.value) void loadListings(true);
  if (tab === "devices" && !devicesLoaded.value) void loadDevices();
}

async function loadApprovals() {
  busy.value = "approvals";
  clearFeedback();
  try {
    confirmations.value = await vaultClient.listSteamConfirmations(props.item.id);
    pendingLogins.value = await vaultClient.listSteamPendingLogins(props.item.id);
    approvalsLoaded.value = true;
  } catch (cause) { setError(cause, "无法读取 Steam 待批准操作。"); }
  finally { busy.value = ""; }
}

async function respondConfirmation(confirmation: SteamConfirmation, accept: boolean) {
  busy.value = `confirmation:${confirmation.id}`;
  clearFeedback();
  try {
    if (!await vaultClient.respondSteamConfirmation(props.item.id, confirmation, accept)) throw new Error("Steam 没有接受该确认操作。");
    confirmations.value = confirmations.value.filter((entry) => entry.id !== confirmation.id);
    notice.value = accept ? "交易确认已允许。" : "交易确认已取消。";
  } catch (cause) { setError(cause, "Steam 交易操作失败。"); }
  finally { busy.value = ""; }
}

async function respondLogin(login: SteamPendingLogin, approve: boolean) {
  busy.value = `login:${login.clientId}`;
  clearFeedback();
  try {
    if (!await vaultClient.respondSteamLogin(props.item.id, { clientId: login.clientId, version: login.version }, approve)) throw new Error("Steam 没有接受该登录操作。");
    pendingLogins.value = pendingLogins.value.filter((entry) => entry.clientId !== login.clientId);
    notice.value = approve ? "登录请求已批准。" : "登录请求已拒绝。";
  } catch (cause) { setError(cause, "Steam 登录操作失败。"); }
  finally { busy.value = ""; }
}

async function loadDevices() {
  busy.value = "devices";
  clearFeedback();
  try {
    devices.value = await vaultClient.listSteamAuthorizedDevices(props.item.id);
    devicesLoaded.value = true;
  } catch (cause) { setError(cause, "无法读取 Steam 授权设备。"); }
  finally { busy.value = ""; }
}

async function loadInventoryOverview() {
  busy.value = "inventory-overview";
  clearFeedback();
  try {
    inventoryOverview.value = await vaultClient.getSteamInventoryOverview(props.item.id);
    inventoryLoaded.value = true;
    const first = inventoryOverview.value.games[0];
    selectedGameKey.value = first ? gameKey(first.appId, first.contextId) : "";
    if (first) await loadInventoryItems(true);
  } catch (cause) { setError(cause, "无法读取 Steam 库存。"); }
  finally { busy.value = ""; }
}

async function changeInventoryGame() {
  selectedAssetIds.value = [];
  quotes.value = {};
  await loadInventoryItems(true);
}

async function loadInventoryItems(reset: boolean) {
  const game = selectedGame.value;
  if (!game) return;
  busy.value = "inventory-items";
  clearFeedback();
  try {
    const page = await vaultClient.listSteamInventoryItems(props.item.id, {
      appId: game.appId,
      contextId: game.contextId,
      startAssetId: reset ? undefined : inventoryCursor.value,
      count: 100
    });
    inventoryItems.value = reset ? page.items : mergeInventoryItems(inventoryItems.value, page.items);
    inventoryCursor.value = page.lastAssetId;
    inventoryHasMore.value = page.hasMore;
  } catch (cause) { setError(cause, "无法读取 Steam 库存项目。"); }
  finally { busy.value = ""; }
}

function mergeInventoryItems(existing: InventoryItem[], incoming: InventoryItem[]): InventoryItem[] {
  const known = new Set(existing.map((entry) => entry.assetId));
  return [...existing, ...incoming.filter((entry) => !known.has(entry.assetId))];
}

function toggleAsset(assetId: string) {
  selectedAssetIds.value = selectedAssetIds.value.includes(assetId) ? selectedAssetIds.value.filter((value) => value !== assetId) : [...selectedAssetIds.value, assetId];
}

async function loadSelectedQuotes() {
  const wallet = inventoryOverview.value?.wallet;
  if (!wallet || !selectedInventoryItems.value.length) return void (error.value = "请先选择可出售的库存项目。");
  busy.value = "quotes";
  clearFeedback();
  try {
    for (const item of selectedInventoryItems.value) {
      quotes.value = { ...quotes.value, [item.assetId]: await vaultClient.getSteamMarketQuote(props.item.id, { appId: item.appId, marketHashName: item.marketHashName, currency: wallet.currency }) };
    }
    notice.value = `已读取 ${selectedInventoryItems.value.length} 项市场报价。`;
  } catch (cause) { setError(cause, "无法读取所选项目的市场报价。"); }
  finally { busy.value = ""; }
}

async function sellSelectedItems() {
  const wallet = inventoryOverview.value?.wallet;
  if (!wallet || !selectedInventoryItems.value.length) return void (error.value = "请先选择可出售的库存项目。");
  const entries = selectedInventoryItems.value.flatMap((item) => {
    const priceReceive = resolveSteamSellerReceive(priceMode.value, quotes.value[item.assetId], wallet, item.publisherFeePercent, manualReceive.value);
    return priceReceive ? [{ appId: item.appId, contextId: item.contextId, assetId: item.assetId, priceReceive }] : [];
  });
  if (entries.length !== selectedInventoryItems.value.length) return void (error.value = priceMode.value === "manual" ? "请输入有效的卖家实收金额。" : "请先读取全部所选项目的市场报价。");
  const autoConfirmText = autoConfirm.value ? "，并自动批准本次新增的市场挂单确认" : "";
  if (!window.confirm(`确定出售 ${entries.length} 个 Steam 库存项目${autoConfirmText}吗？`)) return;
  busy.value = "sell";
  clearFeedback();
  try {
    const result = await vaultClient.sellSteamMarketItems(props.item.id, entries, autoConfirm.value);
    const succeeded = new Set(result.items.filter((entry) => entry.success).map((entry) => entry.assetId));
    inventoryItems.value = inventoryItems.value.filter((entry) => !succeeded.has(entry.assetId));
    selectedAssetIds.value = selectedAssetIds.value.filter((assetId) => !succeeded.has(assetId));
    const failed = result.items.length - succeeded.size;
    notice.value = `已提交 ${succeeded.size} 项出售${result.approvedConfirmationIds.length ? `，自动批准 ${result.approvedConfirmationIds.length} 项市场确认` : ""}。`;
    if (failed) error.value = `${failed} 项出售失败，请检查价格或重新加载库存。`;
  } catch (cause) { setError(cause, "Steam 批量出售失败。"); }
  finally { busy.value = ""; }
}

async function loadListings(reset: boolean) {
  busy.value = "listings";
  clearFeedback();
  try {
    const page = await vaultClient.listSteamMarketListings(props.item.id, { start: reset ? 0 : listingsStart.value, count: 100 });
    listings.value = reset ? page.items : [...listings.value, ...page.items.filter((entry) => !listings.value.some((known) => known.listingId === entry.listingId))];
    listingsStart.value = page.nextStart;
    listingsHasMore.value = page.hasMore;
    listingsLoaded.value = true;
  } catch (cause) { setError(cause, "无法读取 Steam 市场挂单。"); }
  finally { busy.value = ""; }
}

function toggleListing(listingId: string) {
  selectedListingIds.value = selectedListingIds.value.includes(listingId) ? selectedListingIds.value.filter((value) => value !== listingId) : [...selectedListingIds.value, listingId];
}

async function cancelSelectedListings() {
  if (!selectedListingIds.value.length) return;
  const requestedCount = selectedListingIds.value.length;
  if (!window.confirm(`确定撤销 ${requestedCount} 个 Steam 市场挂单吗？`)) return;
  busy.value = "cancel-listings";
  clearFeedback();
  try {
    const cancelled: string[] = [];
    for (const listingId of selectedListingIds.value) if (await vaultClient.cancelSteamMarketListing(props.item.id, listingId)) cancelled.push(listingId);
    listings.value = listings.value.filter((entry) => !cancelled.includes(entry.listingId));
    selectedListingIds.value = selectedListingIds.value.filter((listingId) => !cancelled.includes(listingId));
    notice.value = `已撤销 ${cancelled.length} 个市场挂单。`;
    if (cancelled.length < requestedCount) error.value = "部分挂单撤销失败，请刷新后重试。";
  } catch (cause) { setError(cause, "Steam 挂单撤销失败。"); }
  finally { busy.value = ""; }
}

async function loadProfileBackground() {
  busy.value = "profile";
  clearFeedback();
  try {
    profileBackground.value = await vaultClient.getSteamMiniProfileBackground(props.item.id);
    profileLoaded.value = true;
    if (!profileBackground.value) notice.value = "该 Steam 账号没有可用的迷你资料背景。";
  } catch (cause) { setError(cause, "无法读取 Steam 迷你资料背景。"); }
  finally { busy.value = ""; }
}

function clearFeedback() {
  error.value = "";
  notice.value = "";
}

function setError(cause: unknown, fallback: string) {
  error.value = cause instanceof Error ? cause.message : fallback;
}

function formatDeviceTime(seconds?: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "未知时间";
}
</script>

<template>
  <article class="steam-account-panel">
    <header class="steam-account-header">
      <div><span class="steam-account-label">Steam Guard</span><h2>{{ item.title }}</h2><small>{{ item.steamId || 'SteamID 未识别' }}</small></div>
      <div class="steam-account-visual"><video v-if="profileBackground" :src="profileBackground.preferredUrl" autoplay muted loop playsinline aria-label="Steam 迷你资料背景"></video><m3e-icon-button v-else aria-label="加载 Steam 迷你资料背景" title="加载 Steam 迷你资料背景" :disabled="Boolean(busy) || profileLoaded" @click="loadProfileBackground"><m3e-icon name="animated_images"></m3e-icon></m3e-icon-button><TotpCodeCell :item="item" /></div>
    </header>

    <div class="steam-tabs" role="tablist" aria-label="Steam 账号功能">
      <button v-for="tab in ([['approvals', 'approval', '批准'], ['inventory', 'inventory_2', '库存'], ['market', 'storefront', '市场'], ['devices', 'devices', '设备']] as const)" :key="tab[0]" type="button" role="tab" :aria-selected="activeTab === tab[0]" :class="{ selected: activeTab === tab[0] }" @click="selectTab(tab[0])"><m3e-icon :name="tab[1]"></m3e-icon><span>{{ tab[2] }}</span></button>
    </div>

    <section v-if="activeTab === 'approvals'" class="steam-tab-panel" role="tabpanel">
      <div class="steam-panel-toolbar"><div><h3>待批准操作</h3><small>{{ confirmations.length }} 项交易确认 · {{ pendingLogins.length }} 项登录请求</small></div><m3e-icon-button aria-label="刷新待批准操作" :disabled="Boolean(busy)" @click="loadApprovals"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button></div>
      <div v-if="busy === 'approvals'" class="steam-loading" aria-live="polite">正在读取 Steam 待批准操作…</div>
      <div v-else class="steam-split-list">
        <section><h4>交易确认</h4><ul v-if="filteredConfirmations.length" class="steam-item-list"><li v-for="confirmation in filteredConfirmations" :key="confirmation.id"><span class="steam-list-icon"><m3e-icon name="receipt_long"></m3e-icon></span><span class="steam-list-copy"><strong>{{ confirmation.headline || 'Steam 交易' }}</strong><small>{{ confirmation.summary || '待确认操作' }}</small></span><span class="steam-row-actions"><m3e-button variant="tonal" :disabled="Boolean(busy)" @click="respondConfirmation(confirmation, true)">允许</m3e-button><m3e-button variant="text" :disabled="Boolean(busy)" @click="respondConfirmation(confirmation, false)">取消</m3e-button></span></li></ul><p v-else class="steam-empty">暂无匹配的交易确认</p></section>
        <section><h4>登录请求</h4><ul v-if="filteredLogins.length" class="steam-item-list"><li v-for="login in filteredLogins" :key="login.clientId"><span class="steam-list-icon"><m3e-icon name="login"></m3e-icon></span><span class="steam-list-copy"><strong>{{ login.deviceName || 'Steam 登录设备' }}</strong><small>{{ [login.ip, login.city, login.country].filter(Boolean).join(' · ') || '待批准登录' }}</small></span><span class="steam-row-actions"><m3e-button variant="tonal" :disabled="Boolean(busy)" @click="respondLogin(login, true)">批准</m3e-button><m3e-button variant="text" :disabled="Boolean(busy)" @click="respondLogin(login, false)">拒绝</m3e-button></span></li></ul><p v-else class="steam-empty">暂无匹配的登录请求</p></section>
      </div>
    </section>

    <section v-else-if="activeTab === 'inventory'" class="steam-tab-panel" role="tabpanel">
      <div class="steam-panel-toolbar"><div><h3>库存</h3><small>{{ inventoryOverview?.games.length || 0 }} 个游戏 · {{ inventoryItems.length }} 个已加载项目</small></div><m3e-icon-button aria-label="刷新 Steam 库存" :disabled="Boolean(busy)" @click="loadInventoryOverview"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button></div>
      <div v-if="inventoryOverview?.games.length" class="steam-inventory-controls">
        <label class="steam-field"><span>游戏与库存</span><select v-model="selectedGameKey" :disabled="Boolean(busy)" @change="changeInventoryGame"><option v-for="game in inventoryOverview.games" :key="gameKey(game.appId, game.contextId)" :value="gameKey(game.appId, game.contextId)">{{ game.name }} · {{ game.contextName }}（{{ game.itemCount }}）</option></select></label>
        <label class="steam-field"><span>定价方式</span><select v-model="priceMode" :disabled="Boolean(busy)"><option value="lowest-listing">最低挂单价</option><option value="median">中位价</option><option value="recent-high">近期最高价</option><option value="recent-low">近期最低价</option><option value="manual">手动实收价</option></select></label>
        <label v-if="priceMode === 'manual'" class="steam-field"><span>卖家实收</span><input v-model.number="manualReceive" type="number" inputmode="numeric" min="1" step="1" /></label>
        <label class="steam-toggle"><input v-model="autoConfirm" type="checkbox" /><span>自动批准新市场确认</span></label>
      </div>
      <div v-if="selectedAssetIds.length" class="steam-selection-bar"><strong>已选择 {{ selectedAssetIds.length }} 项</strong><span><m3e-button variant="tonal" :disabled="Boolean(busy)" @click="loadSelectedQuotes"><m3e-icon slot="icon" name="query_stats"></m3e-icon>{{ busy === 'quotes' ? '正在报价…' : '读取报价' }}</m3e-button><m3e-button variant="filled" :disabled="Boolean(busy)" @click="sellSelectedItems"><m3e-icon slot="icon" name="sell"></m3e-icon>{{ busy === 'sell' ? '正在提交…' : '出售选中项' }}</m3e-button></span></div>
      <div v-if="busy === 'inventory-overview' || busy === 'inventory-items'" class="steam-loading" aria-live="polite">正在读取 Steam 库存…</div>
      <ul v-else-if="filteredInventory.length" class="steam-item-list steam-inventory-list"><li v-for="entry in filteredInventory" :key="entry.assetId"><label class="steam-select-control"><input type="checkbox" :checked="selectedAssetIds.includes(entry.assetId)" :disabled="!entry.marketable || Boolean(busy)" :aria-label="`选择${entry.name}`" @change="toggleAsset(entry.assetId)" /></label><img v-if="entry.iconUrl" :src="entry.iconUrl" alt="" loading="lazy" width="48" height="48" /><span v-else class="steam-list-icon"><m3e-icon name="category"></m3e-icon></span><span class="steam-list-copy"><strong>{{ entry.name || entry.marketHashName }}</strong><small>{{ [entry.type, entry.amount > 1 ? `数量 ${entry.amount}` : '', entry.marketable ? '可出售' : '不可出售', entry.tradable ? '可交易' : '不可交易'].filter(Boolean).join(' · ') }}</small><small v-if="quotes[entry.assetId]?.price">最低 {{ quotes[entry.assetId].price?.lowestPrice || '—' }} · 中位 {{ quotes[entry.assetId].price?.medianPrice || '—' }}</small></span></li></ul>
      <p v-else class="steam-empty">{{ inventoryLoaded ? '暂无匹配的库存项目' : '选择刷新以读取库存' }}</p>
      <m3e-button v-if="inventoryHasMore" class="steam-load-more" variant="text" :disabled="Boolean(busy)" @click="loadInventoryItems(false)">加载更多库存</m3e-button>
    </section>

    <section v-else-if="activeTab === 'market'" class="steam-tab-panel" role="tabpanel">
      <div class="steam-panel-toolbar"><div><h3>当前挂单</h3><small>{{ listings.length }} 个已加载挂单</small></div><m3e-icon-button aria-label="刷新 Steam 市场挂单" :disabled="Boolean(busy)" @click="loadListings(true)"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button></div>
      <div v-if="selectedListingIds.length" class="steam-selection-bar"><strong>已选择 {{ selectedListingIds.length }} 项</strong><m3e-button variant="tonal" :disabled="Boolean(busy)" @click="cancelSelectedListings"><m3e-icon slot="icon" name="remove_shopping_cart"></m3e-icon>{{ busy === 'cancel-listings' ? '正在撤销…' : '撤销选中挂单' }}</m3e-button></div>
      <div v-if="busy === 'listings'" class="steam-loading" aria-live="polite">正在读取 Steam 市场挂单…</div>
      <ul v-else-if="filteredListings.length" class="steam-item-list"><li v-for="listing in filteredListings" :key="listing.listingId"><label class="steam-select-control"><input type="checkbox" :checked="selectedListingIds.includes(listing.listingId)" :disabled="Boolean(busy)" :aria-label="`选择${listing.name}`" @change="toggleListing(listing.listingId)" /></label><img v-if="listing.iconUrl" :src="listing.iconUrl" alt="" loading="lazy" width="48" height="48" /><span v-else class="steam-list-icon"><m3e-icon name="sell"></m3e-icon></span><span class="steam-list-copy"><strong>{{ listing.name || listing.marketHashName }}</strong><small>实收 {{ listing.sellerReceives }} · 手续费 {{ listing.fee }} · 买家支付 {{ listing.buyerPrice }}</small><small>挂单号 {{ listing.listingId }}</small></span></li></ul>
      <p v-else class="steam-empty">{{ listingsLoaded ? '暂无匹配的市场挂单' : '选择刷新以读取市场挂单' }}</p>
      <m3e-button v-if="listingsHasMore" class="steam-load-more" variant="text" :disabled="Boolean(busy)" @click="loadListings(false)">加载更多挂单</m3e-button>
    </section>

    <section v-else class="steam-tab-panel" role="tabpanel">
      <div class="steam-panel-toolbar"><div><h3>授权设备</h3><small>{{ devices.length }} 台已授权设备</small></div><m3e-icon-button aria-label="刷新 Steam 授权设备" :disabled="Boolean(busy)" @click="loadDevices"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button></div>
      <div v-if="busy === 'devices'" class="steam-loading" aria-live="polite">正在读取 Steam 授权设备…</div>
      <ul v-else-if="filteredDevices.length" class="steam-item-list"><li v-for="device in filteredDevices" :key="device.tokenId"><span class="steam-list-icon"><m3e-icon :name="device.isCurrent ? 'devices' : 'unknown_med'"></m3e-icon></span><span class="steam-list-copy"><strong>{{ device.description || '未命名 Steam 设备' }}<span v-if="device.isCurrent" class="steam-current-badge">当前设备</span></strong><small>{{ device.lastSeen?.location || device.firstSeen?.location || '位置未知' }} · {{ device.loggedIn ? '已登录' : '未登录' }}</small><small>最近使用 {{ formatDeviceTime(device.lastSeen?.timeSeconds) }} · ID …{{ device.tokenId.slice(-6) }}</small></span></li></ul>
      <p v-else class="steam-empty">{{ devicesLoaded ? '暂无匹配的授权设备' : '选择刷新以读取授权设备' }}</p>
    </section>

    <p v-if="notice" class="steam-notice" aria-live="polite"><m3e-icon name="check_circle"></m3e-icon>{{ notice }}</p>
    <p v-if="error" class="steam-action-error" role="alert"><m3e-icon name="error"></m3e-icon>{{ error }}</p>
  </article>
</template>
