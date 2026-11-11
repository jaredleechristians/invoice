<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

type Member = { id: string; email: string; role: string; joinedAt: string };
type Invite = { id: string; email: string; role: string; token: string; expiresAt: string; expired: boolean };

const { activeCompanyId, capi, cpost, cpatch, cdelete } = useCompanyApi();
const { isAdmin, ensure, role: myRole } = useCompany();
const { user } = useAuth();

const members = ref<Member[]>([]);
const invites = ref<Invite[]>([]);
const error = ref("");
const notice = ref("");
const form = reactive({ email: "", role: "member" });
const creating = ref(false);
const lastLink = ref("");

const roleOptions = computed(() =>
  (myRole.value === "owner" ? ["owner", "admin", "member"] : ["admin", "member"]).map((r) => ({ label: r, value: r }))
);

function inviteLink(token: string) {
  return `${window.location.origin}/dashboard/invite/${token}`;
}

async function load() {
  if (!activeCompanyId.value) return;
  error.value = "";
  try {
    await ensure();
    members.value = (await capi<{ members: Member[] }>("/members")).members;
    invites.value = isAdmin.value ? (await capi<{ invites: Invite[] }>("/invites")).invites : [];
  } catch (e) {
    error.value = errMsg(e);
  }
}

async function createInvite() {
  creating.value = true;
  error.value = "";
  try {
    const inv = await cpost<Invite>("/invites", { email: form.email, role: form.role });
    lastLink.value = inviteLink(inv.token);
    form.email = "";
    await load();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    creating.value = false;
  }
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  notice.value = "Invite link copied.";
  setTimeout(() => (notice.value = ""), 2000);
}

async function changeRole(m: Member, role: string) {
  if (role === m.role) return;
  error.value = "";
  try {
    await cpatch(`/members/${m.id}`, { role });
  } catch (e) {
    error.value = errMsg(e);
  }
  await load();
}

async function remove(m: Member) {
  const self = m.id === user.value?.uid;
  if (!confirm(self ? "Leave this company?" : `Remove ${m.email || m.id}?`)) return;
  error.value = "";
  try {
    await cdelete(`/members/${m.id}`);
    if (self) return navigateTo("/dashboard");
  } catch (e) {
    error.value = errMsg(e);
  }
  await load();
}

async function revoke(i: Invite) {
  try {
    await cdelete(`/invites/${i.id}`);
  } catch (e) {
    error.value = errMsg(e);
  }
  await load();
}

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="space-y-6 max-w-3xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Members</h1>
        <p class="text-muted text-sm mt-1">Owners and admins manage settings and members. Members can create invoices, quotes, payments and expenses.</p>
      </div>
      <UButton to="/dashboard/settings" variant="ghost" color="neutral">Settings</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="notice" color="success" variant="subtle" :title="notice" />

    <UCard>
      <template #header><span class="font-medium">People</span></template>
      <div class="divide-y divide-default">
        <div v-for="m in members" :key="m.id" class="flex flex-wrap items-center gap-3 py-2.5">
          <div class="flex-1 min-w-48">
            <p class="font-medium">{{ m.email || m.id }} <span v-if="m.id === user?.uid" class="text-dimmed text-xs">(you)</span></p>
            <p class="text-xs text-dimmed">Joined {{ new Date(m.joinedAt).toLocaleDateString("en-ZA") }}</p>
          </div>
          <div class="w-32">
            <NSelect
              v-if="isAdmin && (myRole === 'owner' || m.role !== 'owner')"
              :model-value="m.role"
              :options="roleOptions"
              @update:model-value="changeRole(m, String($event))"
            />
            <UBadge v-else variant="subtle" color="neutral">{{ m.role }}</UBadge>
          </div>
          <UButton
            v-if="m.id === user?.uid || (isAdmin && (myRole === 'owner' || m.role !== 'owner'))"
            size="xs"
            color="error"
            variant="ghost"
            @click="remove(m)"
          >
            {{ m.id === user?.uid ? "Leave" : "Remove" }}
          </UButton>
        </div>
      </div>
    </UCard>

    <UCard v-if="isAdmin">
      <template #header><span class="font-medium">Invite someone</span></template>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="createInvite">
        <UFormField label="Email (optional — locks the invite to this address)" class="flex-1 min-w-56">
          <UInput v-model="form.email" type="email" class="w-full" />
        </UFormField>
        <UFormField label="Role" class="w-32">
          <NSelect v-model="form.role" :options="[{ label: 'admin', value: 'admin' }, { label: 'member', value: 'member' }]" />
        </UFormField>
        <UButton type="submit" :loading="creating">Create invite link</UButton>
      </form>
      <p class="text-xs text-dimmed mt-3">Invites are not emailed yet — copy the link and send it yourself. Links expire after 7 days.</p>
      <div v-if="lastLink" class="mt-3 flex gap-2 items-center">
        <UInput :model-value="lastLink" readonly class="flex-1 font-mono text-xs" />
        <UButton size="xs" variant="soft" @click="copy(lastLink)">Copy</UButton>
      </div>
    </UCard>

    <UCard v-if="isAdmin && invites.length">
      <template #header><span class="font-medium">Pending invites</span></template>
      <div class="divide-y divide-default">
        <div v-for="i in invites" :key="i.id" class="flex flex-wrap items-center gap-3 py-2.5 text-sm">
          <div class="flex-1 min-w-48">
            <p>{{ i.email || "Anyone with the link" }} · {{ i.role }}</p>
            <p class="text-xs" :class="i.expired ? 'text-red-400' : 'text-dimmed'">
              {{ i.expired ? "Expired" : "Expires" }} {{ new Date(i.expiresAt).toLocaleString("en-ZA") }}
            </p>
          </div>
          <UButton v-if="!i.expired" size="xs" variant="soft" @click="copy(inviteLink(i.token))">Copy link</UButton>
          <UButton size="xs" color="error" variant="ghost" @click="revoke(i)">Revoke</UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
