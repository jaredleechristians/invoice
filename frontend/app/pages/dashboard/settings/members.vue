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
const inviteOpen = ref(false);
const toast = useToast();

function openInvite() {
  lastLink.value = "";
  form.email = "";
  form.role = "member";
  inviteOpen.value = true;
}

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
    toast.add({ title: "Invite created", color: "success", icon: "i-lucide-check" });
    await load();
  } catch (e) {
    toast.add({ title: "Couldn't create invite", description: errMsg(e), color: "error", icon: "i-lucide-circle-alert" });
  } finally {
    creating.value = false;
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.add({ title: "Invite link copied", color: "success", icon: "i-lucide-copy" });
  } catch {
    toast.add({ title: "Copy failed — select the link and copy it manually", color: "warning" });
  }
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
  <div class="mx-auto w-full max-w-4xl space-y-6">
    <PageHeader title="Members" info="Owners and admins manage settings and members. Members can create invoices, quotes, payments and expenses.">
      <UButton to="/dashboard/settings" variant="ghost" color="neutral" icon="i-lucide-arrow-left">Settings</UButton>
      <UButton v-if="isAdmin" icon="i-lucide-user-plus" @click="openInvite">Invite</UButton>
    </PageHeader>

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
            <AppSelect
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

    <UModal v-model:open="inviteOpen" title="Invite someone" description="Invites aren't emailed yet — copy the link and send it yourself. Links expire after 7 days.">
      <template #body>
        <form v-if="!lastLink" id="invite-form" class="space-y-4" @submit.prevent="createInvite">
          <UFormField label="Email" help="Optional — locks the invite to this address.">
            <UInput v-model="form.email" type="email" autofocus class="w-full" />
          </UFormField>
          <UFormField label="Role">
            <AppSelect v-model="form.role" :options="[{ label: 'Admin', value: 'admin' }, { label: 'Member', value: 'member' }]" />
          </UFormField>
        </form>
        <div v-else class="space-y-2">
          <p class="text-sm text-muted">Invite link created. Share it with the person you're inviting:</p>
          <div class="flex gap-2 items-center">
            <UInput :model-value="lastLink" readonly class="flex-1 font-mono text-xs" />
            <UButton variant="soft" icon="i-lucide-copy" @click="copy(lastLink)">Copy</UButton>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <template v-if="!lastLink">
            <UButton variant="ghost" color="neutral" @click="inviteOpen = false">Cancel</UButton>
            <UButton type="submit" form="invite-form" :loading="creating">Create invite link</UButton>
          </template>
          <UButton v-else @click="inviteOpen = false">Done</UButton>
        </div>
      </template>
    </UModal>

    <UCard v-if="isAdmin && invites.length">
      <template #header><span class="font-medium">Pending invites</span></template>
      <div class="divide-y divide-default">
        <div v-for="i in invites" :key="i.id" class="flex flex-wrap items-center gap-3 py-2.5 text-sm">
          <div class="flex-1 min-w-48">
            <p>{{ i.email || "Anyone with the link" }} · {{ i.role }}</p>
            <p class="text-xs" :class="i.expired ? 'text-error' : 'text-dimmed'">
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
