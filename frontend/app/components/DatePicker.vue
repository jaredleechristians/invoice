<script setup lang="ts">
import { parseDate } from "@internationalized/date";
import { formatDate } from "~/utils/money";

/**
 * Date picker used for every date in the dashboard: a button showing the
 * formatted date that opens a popover with optional presets and a UCalendar.
 *
 * - Single mode (default): v-model is an ISO "YYYY-MM-DD" string ("" = none).
 * - Range mode (`range`):  v-model is { from, to } ISO strings ("" = open-ended).
 */
export type DatePreset = { label: string; value?: string; from?: string; to?: string };
type Range = { from: string; to: string };

const props = withDefaults(
  defineProps<{
    range?: boolean;
    presets?: DatePreset[];
    placeholder?: string;
    clearable?: boolean;
    disabled?: boolean;
    block?: boolean;
    size?: "sm" | "md" | "lg";
  }>(),
  { range: false, presets: () => [], placeholder: undefined, clearable: false, disabled: false, block: false, size: "md" }
);
const model = defineModel<string | Range>({ required: true });
const emit = defineEmits<{ change: [value: string | Range] }>();
const open = ref(false);

function toCal(iso?: string) {
  try {
    return iso ? parseDate(iso) : undefined;
  } catch {
    return undefined;
  }
}
const iso = (d?: { toString(): string } | null) => (d ? d.toString() : "");

const rangeValue = computed(() => (props.range ? (model.value as Range) || { from: "", to: "" } : { from: "", to: "" }));
const singleValue = computed(() => (props.range ? "" : (model.value as string) || ""));

function commit(v: string | Range) {
  model.value = v;
  emit("change", v);
  open.value = false;
}

const calendarRange = computed({
  get: () => ({ start: toCal(rangeValue.value.from), end: toCal(rangeValue.value.to) }),
  set: (v: { start?: { toString(): string } | null; end?: { toString(): string } | null } | null) => {
    if (v?.start && v?.end) commit({ from: iso(v.start), to: iso(v.end) });
  },
});
const calendarSingle = computed({
  get: () => toCal(singleValue.value),
  set: (v: { toString(): string } | null | undefined) => {
    if (v) commit(iso(v));
  },
});

function isActive(p: DatePreset) {
  return props.range
    ? p.from === rangeValue.value.from && p.to === rangeValue.value.to
    : p.value === singleValue.value;
}
const activePreset = computed(() => props.presets.find(isActive));

const empty = computed(() => (props.range ? !rangeValue.value.from && !rangeValue.value.to : !singleValue.value));
const label = computed(() => {
  if (props.range) {
    const { from, to } = rangeValue.value;
    if (!from && !to) return props.placeholder ?? "Any date";
    if (from && to) return `${formatDate(from)} – ${formatDate(to)}`;
    return from ? `From ${formatDate(from)}` : `Until ${formatDate(to)}`;
  }
  return singleValue.value ? formatDate(singleValue.value) : props.placeholder ?? "Pick a date";
});

function pick(p: DatePreset) {
  commit(props.range ? { from: p.from || "", to: p.to || "" } : p.value || "");
}
function clear() {
  commit(props.range ? { from: "", to: "" } : "");
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start', sideOffset: 6 }">
    <UButton
      color="neutral"
      variant="outline"
      :icon="range ? 'i-lucide-calendar-range' : 'i-lucide-calendar'"
      trailing-icon="i-lucide-chevron-down"
      :size="size"
      :block="block"
      :disabled="disabled"
      class="justify-between font-normal"
      :class="range ? 'min-w-60' : 'min-w-40'"
      :ui="{ trailingIcon: 'text-dimmed ms-auto' }"
    >
      <span class="truncate" :class="empty ? 'text-dimmed' : 'text-default'">{{ label }}</span>
      <UBadge v-if="range && activePreset" size="sm" variant="subtle" color="primary" class="ms-1">{{ activePreset.label }}</UBadge>
    </UButton>

    <template #content>
      <div class="flex flex-col sm:flex-row">
        <div
          v-if="presets.length || clearable"
          class="flex sm:flex-col gap-1 p-2 overflow-x-auto sm:w-40 border-b sm:border-b-0 sm:border-e border-default"
        >
          <UButton
            v-for="p in presets"
            :key="p.label"
            :label="p.label"
            size="sm"
            color="neutral"
            :variant="isActive(p) ? 'soft' : 'ghost'"
            :class="isActive(p) ? 'text-primary' : ''"
            class="shrink-0"
            @click="pick(p)"
          />
          <UButton
            v-if="clearable"
            :label="range ? 'All dates' : 'Clear'"
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            class="shrink-0"
            @click="clear"
          />
        </div>
        <div class="p-2">
          <template v-if="range">
            <UCalendar v-model="calendarRange" range :number-of-months="2" class="hidden sm:block" />
            <UCalendar v-model="calendarRange" range class="sm:hidden" />
          </template>
          <UCalendar v-else v-model="calendarSingle" />
        </div>
      </div>
    </template>
  </UPopover>
</template>
