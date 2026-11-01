/**
 * "Request a refund" — full-screen form over Order details.
 *
 * The customer picks what went wrong, which items (and how many), writes a
 * few words and, for damaged / wrong / quality issues, adds photos. No amount
 * is ever typed or sent: the server values the chosen items and an admin
 * reviews the request (it may approve less than asked).
 *
 * Photos go up with the request as multipart/form-data and are stored
 * privately — only Aadione's refund team can see them.
 */

import { useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation } from "@tanstack/react-query";
import { Camera, ImagePlus, Minus, Plus, X } from "lucide-react-native";
import type { CustomerRefundRequestDto, OrderItemDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { api, ApiRequestError } from "@/lib/api";
import { AppText, Button, NoticeStrip } from "@/components/ui";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_REFUND_PHOTOS,
  REFUND_CATEGORIES,
  refundFormItems,
  refundFormProblem,
  type RefundCategoryValue,
} from "@/lib/refunds";

interface Photo {
  uri: string;
  name: string;
  type: string;
}

export function RefundRequestModal({
  visible,
  orderId,
  items,
  refundableItemIds,
  photoRequiredCategories,
  onClose,
  onSubmitted,
}: {
  visible: boolean;
  orderId: string;
  items: readonly OrderItemDto[];
  refundableItemIds: readonly string[];
  photoRequiredCategories: readonly string[];
  onClose: () => void;
  onSubmitted: (request: CustomerRefundRequestDto) => void;
}) {
  const insets = useSafeAreaInsets();
  const [category, setCategory] = useState<RefundCategoryValue | null>(null);
  const [description, setDescription] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refundable = items.filter((item) => refundableItemIds.includes(item.id));
  const form = { category, description, quantities, photoCount: photos.length };
  const problem = refundFormProblem(form, photoRequiredCategories);
  const photoRequired = category !== null && photoRequiredCategories.includes(category);

  const submit = useMutation({
    mutationFn: () => {
      const body = new FormData();
      body.append("category", category ?? "");
      body.append("description", description.trim());
      body.append("items", JSON.stringify(refundFormItems(form)));
      for (const photo of photos) {
        // React Native's FormData takes a file descriptor object.
        body.append("photos", { uri: photo.uri, name: photo.name, type: photo.type } as unknown as Blob);
      }
      return api.postForm<CustomerRefundRequestDto>(`/orders/${orderId}/refund-requests`, body);
    },
    onSuccess: (request) => {
      setError(null);
      reset();
      onSubmitted(request);
    },
    onError: (err: Error) => {
      setError(err instanceof ApiRequestError ? err.message : "Could not send your request. Please try again.");
    },
  });

  function reset() {
    setCategory(null);
    setDescription("");
    setQuantities({});
    setPhotos([]);
  }

  function setQty(item: OrderItemDto, qty: number) {
    setQuantities((current) => ({ ...current, [item.id]: Math.max(0, Math.min(item.qty, qty)) }));
  }

  async function addPhotos(fromCamera: boolean) {
    const room = MAX_REFUND_PHOTOS - photos.length;
    if (room <= 0) return;
    const permission = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", fromCamera ? "Allow camera access to take a photo." : "Allow photo access to attach a picture.");
      return;
    }
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 0.6,
      allowsMultipleSelection: !fromCamera,
      selectionLimit: room,
    };
    const result = fromCamera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return;
    const picked = result.assets.slice(0, room).map((asset, index) => {
      const type = asset.mimeType ?? "image/jpeg";
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      return { uri: asset.uri, type, name: asset.fileName ?? `photo-${Date.now()}-${index}.${ext}` };
    });
    setPhotos((current) => [...current, ...picked].slice(0, MAX_REFUND_PHOTOS));
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <View style={styles.headerText}>
            <AppText variant="h3">Request a refund</AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              Our team reviews every request
            </AppText>
          </View>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <X size={24} strokeWidth={2.2} color={colors.textPrimary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]} keyboardShouldPersistTaps="handled">
          <AppText variant="bodyStrong" style={styles.label}>
            What went wrong?
          </AppText>
          <View style={styles.chips}>
            {REFUND_CATEGORIES.map((option) => {
              const selected = category === option.value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => setCategory(option.value)}
                  style={[styles.chip, selected && styles.chipSelected]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <AppText variant="caption" color={selected ? colors.onPrimary : colors.textPrimary} style={styles.chipText}>
                    {option.label}
                  </AppText>
                </Pressable>
              );
            })}
          </View>

          <AppText variant="bodyStrong" style={styles.label}>
            Which items?
          </AppText>
          {refundable.map((item) => {
            const qty = quantities[item.id] ?? 0;
            return (
              <View key={item.id} style={[styles.itemRow, qty > 0 && styles.itemRowSelected]}>
                <View style={styles.itemText}>
                  <AppText variant="body" numberOfLines={2}>
                    {item.productName}
                  </AppText>
                  <AppText variant="caption" color={colors.textSecondary}>
                    {item.variantName} · bought {item.qty} · {formatPaise(item.lineTotalPaise)}
                  </AppText>
                </View>
                <View style={styles.stepper}>
                  <Pressable onPress={() => setQty(item, qty - 1)} disabled={qty === 0} hitSlop={8} style={styles.stepButton} accessibilityLabel={`Fewer ${item.productName}`}>
                    <Minus size={16} strokeWidth={2.4} color={qty === 0 ? colors.textMuted : colors.primary} />
                  </Pressable>
                  <AppText variant="bodyStrong" style={styles.qty}>
                    {qty}
                  </AppText>
                  <Pressable onPress={() => setQty(item, qty + 1)} disabled={qty >= item.qty} hitSlop={8} style={styles.stepButton} accessibilityLabel={`More ${item.productName}`}>
                    <Plus size={16} strokeWidth={2.4} color={qty >= item.qty ? colors.textMuted : colors.primary} />
                  </Pressable>
                </View>
              </View>
            );
          })}

          <AppText variant="bodyStrong" style={styles.label}>
            Tell us more
          </AppText>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="For example: one packet was missing from the bag."
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={MAX_DESCRIPTION_LENGTH}
            style={styles.textArea}
            accessibilityLabel="Describe the problem"
          />

          <AppText variant="bodyStrong" style={styles.label}>
            Photos {photoRequired ? "(required)" : "(optional)"}
          </AppText>
          <View style={styles.photos}>
            {photos.map((photo) => (
              <View key={photo.uri} style={styles.photo}>
                <Image source={{ uri: photo.uri }} style={styles.photoImage} contentFit="cover" />
                <Pressable
                  onPress={() => setPhotos((current) => current.filter((p) => p.uri !== photo.uri))}
                  style={styles.photoRemove}
                  hitSlop={8}
                  accessibilityLabel="Remove photo"
                >
                  <X size={14} strokeWidth={2.6} color={colors.onPrimary} />
                </Pressable>
              </View>
            ))}
            {photos.length < MAX_REFUND_PHOTOS && (
              <>
                <Pressable onPress={() => void addPhotos(false)} style={styles.addPhoto} accessibilityRole="button" accessibilityLabel="Add photos from gallery">
                  <ImagePlus size={22} strokeWidth={2} color={colors.primary} />
                  <AppText variant="caption" color={colors.primary}>
                    Gallery
                  </AppText>
                </Pressable>
                <Pressable onPress={() => void addPhotos(true)} style={styles.addPhoto} accessibilityRole="button" accessibilityLabel="Take a photo">
                  <Camera size={22} strokeWidth={2} color={colors.primary} />
                  <AppText variant="caption" color={colors.primary}>
                    Camera
                  </AppText>
                </Pressable>
              </>
            )}
          </View>
          <AppText variant="caption" color={colors.textSecondary}>
            Only Aadione's refund team can see your photos.
          </AppText>

          {error && (
            <View style={styles.notice}>
              <NoticeStrip message={error} />
            </View>
          )}

          <Button
            label="Send request"
            onPress={() => submit.mutate()}
            disabled={problem !== null}
            loading={submit.isPending}
            style={styles.submit}
          />
          {problem && (
            <AppText variant="caption" color={colors.textSecondary} style={styles.hint}>
              {problem}
            </AppText>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerText: { flex: 1 },
  content: { padding: spacing.base },
  label: { marginTop: spacing.lg, marginBottom: spacing.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: "600" },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  itemRowSelected: { borderColor: colors.primary, backgroundColor: colors.primarySurface },
  itemText: { flex: 1 },
  stepper: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  stepButton: {
    width: 32,
    height: 32,
    borderRadius: radius.circle,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  qty: { minWidth: 22, textAlign: "center" },
  textArea: {
    minHeight: 100,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    textAlignVertical: "top",
    color: colors.textPrimary,
    fontSize: 15,
  },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  photo: { width: 76, height: 76, borderRadius: radius.md, overflow: "hidden" },
  photoImage: { width: "100%", height: "100%" },
  photoRemove: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
  },
  addPhoto: {
    width: 76,
    height: 76,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.primary,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  notice: { marginTop: spacing.md },
  submit: { marginTop: spacing.xl },
  hint: { marginTop: spacing.sm, textAlign: "center" },
});
