import type { ProduceItem, ProducePack } from './types';

/**
 * What is in season, by country, region and month. This is the list the app shows under "In season near you".
 *
 * It is meant to be corrected by whoever knows the local market, not only by a programmer. To change something:
 *  - `months` are the months it is worth buying, 1 = January, 12 = December. Winter things wrap, e.g. [11, 12, 1, 2].
 *  - `kind` is 'fruit', 'veg' or 'herb'. Fruit gets the fruit icon, everything else a leaf.
 *  - `use` is the one short line under the name: a portion for fruit ("1 medium"), or how to eat it ("salad").
 *  - A region's list replaces the country list for the cities named in it. It is not added to it, so each region
 *    list has to be complete on its own.
 *  - After any edit, add one to that country's `version` and put today's date in `updatedAt`.
 */

// Shared lists, so countries with the same market do not drift apart.

const SOUTH_ASIA: ProduceItem[] = [
  { name: 'Guava', kind: 'fruit', use: '1 medium', months: [11, 12, 1, 2] },
  { name: 'Pomegranate', kind: 'fruit', use: '½ cup', months: [9, 10, 11, 12] },
  { name: 'Apple', kind: 'fruit', use: '1 small', months: [8, 9, 10, 11, 12] },
  { name: 'Mandarin', kind: 'fruit', use: '2 small', months: [12, 1, 2, 3] },
  { name: 'Mango', kind: 'fruit', use: '½ cup', months: [5, 6, 7, 8] },
  { name: 'Watermelon', kind: 'fruit', use: '1 cup', months: [4, 5, 6, 7] },
  { name: 'Banana', kind: 'fruit', use: '1 medium', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { name: 'Spinach', kind: 'veg', use: 'salad / salan', months: [10, 11, 12, 1, 2, 3] },
  { name: 'Carrot', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3] },
  { name: 'Radish', kind: 'veg', use: 'salad', months: [10, 11, 12, 1, 2] },
  { name: 'Cauliflower', kind: 'veg', use: 'sabzi', months: [10, 11, 12, 1, 2] },
  { name: 'Fenugreek', kind: 'herb', use: 'tea · greens', months: [10, 11, 12, 1, 2] },
  { name: 'Okra', kind: 'veg', use: 'sabzi', months: [4, 5, 6, 7, 8, 9] },
  { name: 'Bottle gourd', kind: 'veg', use: 'salan', months: [4, 5, 6, 7, 8, 9] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [3, 4, 5, 6, 7, 8, 9] },
];

const GULF: ProduceItem[] = [
  { name: 'Dates', kind: 'fruit', use: '2 to 3', months: [7, 8, 9, 10] },
  { name: 'Orange', kind: 'fruit', use: '1 medium', months: [12, 1, 2, 3] },
  { name: 'Strawberry', kind: 'fruit', use: '½ cup', months: [12, 1, 2, 3] },
  { name: 'Fig', kind: 'fruit', use: '2 small', months: [6, 7, 8] },
  { name: 'Watermelon', kind: 'fruit', use: '1 cup', months: [4, 5, 6] },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3, 4] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3, 4, 5] },
  { name: 'Zucchini', kind: 'veg', use: 'grilled', months: [11, 12, 1, 2, 3, 4] },
  { name: 'Capsicum', kind: 'veg', use: 'salad · stir-fry', months: [11, 12, 1, 2, 3] },
  { name: 'Leafy greens', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3] },
  { name: 'Aubergine', kind: 'veg', use: 'roasted', months: [11, 12, 1, 2, 3] },
  { name: 'Mint', kind: 'herb', use: 'tea · chutney', months: [10, 11, 12, 1, 2, 3, 4] },
];

const NORTH_TEMPERATE: ProduceItem[] = [
  { name: 'Apple', kind: 'fruit', use: '1 small', months: [9, 10, 11, 12] },
  { name: 'Pear', kind: 'fruit', use: '1 small', months: [9, 10, 11, 12] },
  { name: 'Berries', kind: 'fruit', use: '½ cup', months: [6, 7, 8] },
  { name: 'Citrus', kind: 'fruit', use: '1 medium', months: [12, 1, 2, 3] },
  { name: 'Kale', kind: 'veg', use: 'salad / soup', months: [10, 11, 12, 1, 2] },
  { name: 'Leek', kind: 'veg', use: 'soup', months: [10, 11, 12, 1, 2, 3] },
  { name: 'Squash', kind: 'veg', use: 'roasted', months: [9, 10, 11, 12] },
  { name: 'Broccoli', kind: 'veg', use: 'steamed', months: [9, 10, 11] },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: [6, 7, 8, 9] },
  { name: 'Courgette', kind: 'veg', use: 'grilled', months: [6, 7, 8, 9] },
];

const PUNJAB: ProduceItem[] = [
  { name: 'Guava', kind: 'fruit', use: '1 medium', months: [11, 12, 1, 2] },
  { name: 'Kinnow', kind: 'fruit', use: '2 small', months: [12, 1, 2, 3] },
  { name: 'Pomegranate', kind: 'fruit', use: '½ cup', months: [9, 10, 11, 12] },
  { name: 'Apple', kind: 'fruit', use: '1 small', months: [8, 9, 10, 11, 12] },
  { name: 'Mango', kind: 'fruit', use: '½ cup', months: [5, 6, 7, 8] },
  { name: 'Peach', kind: 'fruit', use: '2 small', months: [5, 6, 7] },
  { name: 'Falsa', kind: 'fruit', use: '½ cup', months: [5, 6] },
  { name: 'Melon', kind: 'fruit', use: '1 cup', months: [4, 5, 6, 7] },
  { name: 'Mustard greens', kind: 'veg', use: 'saag', months: [11, 12, 1, 2] },
  { name: 'Spinach', kind: 'veg', use: 'salad / salan', months: [10, 11, 12, 1, 2, 3] },
  { name: 'Carrot', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3] },
  { name: 'Radish', kind: 'veg', use: 'salad', months: [10, 11, 12, 1, 2] },
  { name: 'Turnip', kind: 'veg', use: 'sabzi', months: [11, 12, 1, 2] },
  { name: 'Cauliflower', kind: 'veg', use: 'sabzi', months: [10, 11, 12, 1, 2] },
  { name: 'Peas', kind: 'veg', use: 'pulao · sabzi', months: [11, 12, 1, 2] },
  { name: 'Fenugreek', kind: 'herb', use: 'tea · greens', months: [10, 11, 12, 1, 2] },
  { name: 'Okra', kind: 'veg', use: 'sabzi', months: [4, 5, 6, 7, 8, 9] },
  { name: 'Bottle gourd', kind: 'veg', use: 'salan', months: [4, 5, 6, 7, 8, 9] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [3, 4, 5, 6, 7, 8, 9] },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: [12, 1, 2, 3, 4] },
];

const SINDH: ProduceItem[] = [
  { name: 'Banana', kind: 'fruit', use: '1 medium', months: [8, 9, 10, 11, 12, 1] },
  { name: 'Chikoo', kind: 'fruit', use: '2 small', months: [1, 2, 3, 4] },
  { name: 'Papaya', kind: 'fruit', use: '½ cup', months: [9, 10, 11, 12, 1] },
  { name: 'Mango', kind: 'fruit', use: '½ cup', months: [4, 5, 6, 7] },
  { name: 'Dates', kind: 'fruit', use: '2 to 3', months: [6, 7, 8] },
  { name: 'Guava', kind: 'fruit', use: '1 medium', months: [11, 12, 1, 2] },
  { name: 'Watermelon', kind: 'fruit', use: '1 cup', months: [3, 4, 5, 6] },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3] },
  { name: 'Spinach', kind: 'veg', use: 'salad / salan', months: [11, 12, 1, 2] },
  { name: 'Cauliflower', kind: 'veg', use: 'sabzi', months: [11, 12, 1] },
  { name: 'Okra', kind: 'veg', use: 'sabzi', months: [3, 4, 5, 6, 7, 8, 9, 10] },
  { name: 'Bottle gourd', kind: 'veg', use: 'salan', months: [3, 4, 5, 6, 7, 8, 9, 10] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [2, 3, 4, 5, 6, 7, 8, 9] },
  { name: 'Coriander', kind: 'herb', use: 'chutney · garnish', months: [11, 12, 1, 2] },
];

const KHYBER_PAKHTUNKHWA: ProduceItem[] = [
  { name: 'Apple', kind: 'fruit', use: '1 small', months: [8, 9, 10, 11] },
  { name: 'Persimmon', kind: 'fruit', use: '1 small', months: [10, 11, 12] },
  { name: 'Peach', kind: 'fruit', use: '2 small', months: [5, 6, 7] },
  { name: 'Apricot', kind: 'fruit', use: '3 small', months: [5, 6, 7] },
  { name: 'Plum', kind: 'fruit', use: '2 small', months: [6, 7, 8] },
  { name: 'Walnut', kind: 'fruit', use: '4 halves', months: [9, 10, 11] },
  { name: 'Guava', kind: 'fruit', use: '1 medium', months: [11, 12, 1] },
  { name: 'Mustard greens', kind: 'veg', use: 'saag', months: [11, 12, 1, 2] },
  { name: 'Spinach', kind: 'veg', use: 'salad / salan', months: [10, 11, 12, 1, 2, 3] },
  { name: 'Turnip', kind: 'veg', use: 'sabzi', months: [11, 12, 1, 2] },
  { name: 'Carrot', kind: 'veg', use: 'salad', months: [11, 12, 1, 2] },
  { name: 'Pumpkin', kind: 'veg', use: 'sabzi · soup', months: [8, 9, 10, 11] },
  { name: 'Okra', kind: 'veg', use: 'sabzi', months: [5, 6, 7, 8, 9] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [4, 5, 6, 7, 8] },
];

const BALOCHISTAN: ProduceItem[] = [
  { name: 'Apple', kind: 'fruit', use: '1 small', months: [8, 9, 10, 11] },
  { name: 'Grapes', kind: 'fruit', use: '½ cup', months: [7, 8, 9] },
  { name: 'Cherry', kind: 'fruit', use: '½ cup', months: [5, 6] },
  { name: 'Apricot', kind: 'fruit', use: '3 small', months: [6, 7] },
  { name: 'Pomegranate', kind: 'fruit', use: '½ cup', months: [9, 10, 11] },
  { name: 'Dates', kind: 'fruit', use: '2 to 3', months: [7, 8, 9] },
  { name: 'Melon', kind: 'fruit', use: '1 cup', months: [5, 6, 7] },
  { name: 'Spinach', kind: 'veg', use: 'salad / salan', months: [10, 11, 12, 1, 2] },
  { name: 'Cauliflower', kind: 'veg', use: 'sabzi', months: [10, 11, 12, 1] },
  { name: 'Carrot', kind: 'veg', use: 'salad', months: [11, 12, 1, 2] },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: [7, 8, 9, 10] },
  { name: 'Okra', kind: 'veg', use: 'sabzi', months: [6, 7, 8, 9] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [5, 6, 7, 8, 9] },
];

const ABU_DHABI: ProduceItem[] = [
  { name: 'Dates', kind: 'fruit', use: '2 to 3', months: [6, 7, 8, 9, 10] },
  { name: 'Mango', kind: 'fruit', use: '½ cup', months: [6, 7, 8] },
  { name: 'Fig', kind: 'fruit', use: '2 small', months: [6, 7, 8] },
  { name: 'Orange', kind: 'fruit', use: '1 medium', months: [12, 1, 2, 3] },
  { name: 'Strawberry', kind: 'fruit', use: '½ cup', months: [12, 1, 2, 3] },
  { name: 'Watermelon', kind: 'fruit', use: '1 cup', months: [4, 5, 6] },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3, 4] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3, 4, 5] },
  { name: 'Zucchini', kind: 'veg', use: 'grilled', months: [11, 12, 1, 2, 3, 4] },
  { name: 'Capsicum', kind: 'veg', use: 'salad · stir-fry', months: [11, 12, 1, 2, 3] },
  { name: 'Leafy greens', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3] },
  { name: 'Pumpkin', kind: 'veg', use: 'roasted · soup', months: [11, 12, 1] },
  { name: 'Mint', kind: 'herb', use: 'tea · chutney', months: [10, 11, 12, 1, 2, 3, 4] },
];

const NORTHERN_EMIRATES: ProduceItem[] = [
  { name: 'Dates', kind: 'fruit', use: '2 to 3', months: [7, 8, 9, 10] },
  { name: 'Strawberry', kind: 'fruit', use: '½ cup', months: [12, 1, 2, 3] },
  { name: 'Guava', kind: 'fruit', use: '1 medium', months: [11, 12, 1] },
  { name: 'Mango', kind: 'fruit', use: '½ cup', months: [6, 7, 8] },
  { name: 'Orange', kind: 'fruit', use: '1 medium', months: [12, 1, 2, 3] },
  { name: 'Fig', kind: 'fruit', use: '2 small', months: [6, 7, 8] },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3, 4] },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3, 4, 5] },
  { name: 'Zucchini', kind: 'veg', use: 'grilled', months: [11, 12, 1, 2, 3, 4] },
  { name: 'Aubergine', kind: 'veg', use: 'roasted', months: [11, 12, 1, 2, 3] },
  { name: 'Leafy greens', kind: 'veg', use: 'salad', months: [11, 12, 1, 2, 3] },
  { name: 'Cabbage', kind: 'veg', use: 'salad · stir-fry', months: [12, 1, 2] },
  { name: 'Mint', kind: 'herb', use: 'tea · chutney', months: [10, 11, 12, 1, 2, 3, 4] },
];

/** Available most of the year, most places: the list for countries nobody has written up yet. */
const ALL_YEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const EVERYWHERE: ProduceItem[] = [
  { name: 'Banana', kind: 'fruit', use: '1 medium', months: ALL_YEAR },
  { name: 'Apple', kind: 'fruit', use: '1 small', months: ALL_YEAR },
  { name: 'Orange', kind: 'fruit', use: '1 medium', months: ALL_YEAR },
  { name: 'Carrot', kind: 'veg', use: 'salad', months: ALL_YEAR },
  { name: 'Tomato', kind: 'veg', use: 'salad', months: ALL_YEAR },
  { name: 'Cucumber', kind: 'veg', use: 'salad', months: ALL_YEAR },
  { name: 'Spinach', kind: 'veg', use: 'salad / soup', months: ALL_YEAR },
  { name: 'Lemon', kind: 'herb', use: 'in water · over salad', months: ALL_YEAR },
];

/** The country code of the neutral list, used when a country has no pack of its own. */
export const DEFAULT_COUNTRY = 'ZZ';

export const PRODUCE_PACKS: ProducePack[] = [
  {
    country: 'PK',
    name: 'Pakistan',
    version: 1,
    updatedAt: '2026-11-27',
    items: SOUTH_ASIA,
    regions: [
      { region: 'Punjab', items: PUNJAB, cities: ['Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Gujranwala', 'Sialkot', 'Sargodha', 'Bahawalpur', 'Sahiwal', 'Jhelum', 'Gujrat', 'Sheikhupura', 'Rahim Yar Khan', 'Dera Ghazi Khan', 'Okara', 'Kasur', 'Chiniot'] },
      { region: 'Sindh', items: SINDH, cities: ['Karachi', 'Hyderabad', 'Sukkur', 'Larkana', 'Nawabshah', 'Mirpur Khas', 'Shikarpur', 'Jacobabad', 'Thatta', 'Dadu'] },
      { region: 'Khyber Pakhtunkhwa', items: KHYBER_PAKHTUNKHWA, cities: ['Peshawar', 'Mardan', 'Abbottabad', 'Mingora', 'Swat', 'Kohat', 'Nowshera', 'Dera Ismail Khan', 'Charsadda', 'Mansehra'] },
      { region: 'Balochistan', items: BALOCHISTAN, cities: ['Quetta', 'Gwadar', 'Turbat', 'Khuzdar', 'Chaman', 'Sibi', 'Zhob', 'Loralai'] },
    ],
  },
  {
    country: 'AE',
    name: 'United Arab Emirates',
    version: 1,
    updatedAt: '2026-11-27',
    items: GULF,
    regions: [
      { region: 'Abu Dhabi', items: ABU_DHABI, cities: ['Abu Dhabi', 'Al Ain', 'Madinat Zayed', 'Liwa', 'Ruwais', 'Ghayathi'] },
      { region: 'Dubai and the Northern Emirates', items: NORTHERN_EMIRATES, cities: ['Dubai', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain', 'Al Dhaid', 'Khor Fakkan', 'Dibba Al-Fujairah'] },
    ],
  },
  { country: 'IN', name: 'India', version: 1, updatedAt: '2026-11-27', items: SOUTH_ASIA, regions: [] },
  { country: 'BD', name: 'Bangladesh', version: 1, updatedAt: '2026-11-27', items: SOUTH_ASIA, regions: [] },
  { country: 'SA', name: 'Saudi Arabia', version: 1, updatedAt: '2026-11-27', items: GULF, regions: [] },
  { country: 'QA', name: 'Qatar', version: 1, updatedAt: '2026-11-27', items: GULF, regions: [] },
  { country: 'OM', name: 'Oman', version: 1, updatedAt: '2026-11-27', items: GULF, regions: [] },
  { country: 'GB', name: 'United Kingdom', version: 1, updatedAt: '2026-11-27', items: NORTH_TEMPERATE, regions: [] },
  { country: 'US', name: 'United States', version: 1, updatedAt: '2026-11-27', items: NORTH_TEMPERATE, regions: [] },
  { country: 'CA', name: 'Canada', version: 1, updatedAt: '2026-11-27', items: NORTH_TEMPERATE, regions: [] },
  { country: DEFAULT_COUNTRY, name: 'Everywhere else', version: 1, updatedAt: '2026-11-27', items: EVERYWHERE, regions: [] },
];
