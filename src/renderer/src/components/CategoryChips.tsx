import { CATEGORY_LABELS, type Category } from '@shared/categories';
import './category-chips.css';

interface CategoryChipsProps {
  readonly categories: readonly Category[];
  /** When set, chips are buttons that apply the category as a filter. */
  readonly onSelect?: ((category: Category) => void) | undefined;
}

/** Small, square-ish tags for a clip's automatic categories. Renders nothing for none. */
export function CategoryChips({ categories, onSelect }: CategoryChipsProps) {
  if (categories.length === 0) return null;
  return (
    <span className="category-chips">
      {categories.map((category) => {
        const label = CATEGORY_LABELS[category];
        const className = `category-chip category-chip--${category}`;
        return onSelect ? (
          <button
            key={category}
            type="button"
            className={className}
            title={`Show only ${label} clips`}
            onClick={() => onSelect(category)}
          >
            {label}
          </button>
        ) : (
          <span key={category} className={className}>
            {label}
          </span>
        );
      })}
    </span>
  );
}
