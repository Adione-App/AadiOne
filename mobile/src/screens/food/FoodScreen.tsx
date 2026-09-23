/**
 * Food tab placeholder.
 *
 * A dedicated food-ordering flow isn't built yet — this tells the customer
 * that plainly instead of leaving the tab empty or dead.
 */

import { Ionicons } from '@expo/vector-icons';
import { colors } from '@shared/theme';
import ComingSoonScreen from '@/screens/common/ComingSoonScreen';

export default function FoodScreen() {
  return (
    <ComingSoonScreen
      icon={<Ionicons name="fast-food" size={56} color={colors.primary} />}
      message="We're cooking up something tasty. Food ordering will be available here soon — stay tuned!"
    />
  );
}
