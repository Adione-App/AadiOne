/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Smart Search — the English / Hinglish / Hindi synonym dictionary.
 *
 * Each group lists ONE thing under every name a customer, seller or admin
 * might type for it: English (singular, plural, common misspellings), Roman
 * Hindi spellings and Hindi script. Matching is spelling-insensitive
 * (search-text.ts phoneticKey), so a group needs one spelling per SOUND, not
 * every vowel-length variant: "aloo" already covers "alu", "aaloo", "आलू".
 *
 * Used on both sides:
 *   - indexing: a product whose name / Hindi name / keywords contain any
 *     member gets the whole group as searchable SYNONYM terms
 *     (backend/src/infra/search/terms.ts);
 *   - querying: a query word in a group (or a close typo of one) also
 *     searches the rest of the group (search-match.ts analyzeSearchQuery).
 *
 * Seeded from the real Aadione catalogue (vegetables and fruits sold as
 * "Banana (केला)", dals, masalas, namkeen, the restaurants' menus, clothing,
 * kitchenware). Translation, not transliteration: "kela" -> "banana" only
 * works because a group says so.
 *
 * RULES for adding a group (they keep unrelated products out of results):
 *   - one meaning per group; a word with two meanings ("sitaphal" is pumpkin
 *     in some regions, custard apple in others) goes in neither, and a word
 *     that is part of another product's name stays out ("lime" would tag
 *     Sweet Lime as nimbu);
 *   - no generic English words ("long" for clove, "paste" for toothpaste);
 *   - multi-word members are fine ("lady finger"); they match as phrases.
 * Product-specific spellings belong in that product's own search keywords
 * (seller/admin "Search keywords" field), not here.
 */

export const SEARCH_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  /* vegetables ------------------------------------------------------------ */
  ['potato', 'potatoes', 'aloo', 'alu', 'batata', 'आलू'],
  ['tomato', 'tomatoes', 'tamatar', 'tamater', 'tamatr', 'टमाटर'],
  ['onion', 'onions', 'pyaz', 'pyaaz', 'pyaj', 'kanda', 'प्याज', 'प्याज़', 'कांदा'],
  ['garlic', 'lehsun', 'lahsun', 'lasun', 'lehsan', 'लहसुन'],
  ['ginger', 'adrak', 'adarak', 'अदरक'],
  ['chilli', 'chili', 'chilly', 'chillies', 'chilies', 'mirch', 'mirchi', 'मिर्च', 'मिर्ची'],
  ['green chilli', 'hari mirch', 'हरी मिर्च'],
  ['red chilli', 'lal mirch', 'लाल मिर्च'],
  ['yellow chilli', 'peeli mirch', 'पीली मिर्च'],
  ['capsicum', 'bell pepper', 'shimla mirch', 'शिमला मिर्च'],
  ['coriander', 'dhaniya', 'dhania', 'cilantro', 'धनिया'],
  ['mint', 'pudina', 'podina', 'पुदीना'],
  ['spinach', 'palak', 'पालक'],
  ['fenugreek', 'methi', 'मेथी'],
  ['cucumber', 'kheera', 'khira', 'खीरा'],
  ['carrot', 'carrots', 'gajar', 'गाजर'],
  ['radish', 'mooli', 'मूली'],
  ['cabbage', 'patta gobhi', 'pattagobhi', 'band gobhi', 'पत्तागोभी', 'पत्ता गोभी', 'बंद गोभी'],
  ['cauliflower', 'phool gobhi', 'phoolgobhi', 'gobhi', 'gobi', 'फूलगोभी', 'फूल गोभी', 'गोभी'],
  ['brinjal', 'eggplant', 'aubergine', 'baingan', 'bengan', 'baigan', 'बैंगन'],
  ['okra', 'lady finger', 'ladyfinger', 'ladys finger', 'ladies finger', 'bhindi', 'भिंडी'],
  ['peas', 'green peas', 'matar', 'mater', 'mutter', 'मटर'],
  ['bottle gourd', 'lauki', 'louki', 'ghiya', 'dudhi', 'लौकी'],
  ['ridge gourd', 'turai', 'torai', 'tori', 'turiya', 'तोरई', 'तुरई'],
  ['bitter gourd', 'karela', 'करेला'],
  ['pumpkin', 'kaddu', 'कद्दू'],
  ['pointed gourd', 'parwal', 'परवल'],
  ['sponge gourd', 'gilki', 'गिलकी'],
  ['ivy gourd', 'tindora', 'tindori', 'kundru', 'टिंडोरी', 'कुंदरू'],
  ['snake gourd', 'chichinda', 'sarsinda', 'चिचिंडा', 'सरसिंदा'],
  ['drumstick', 'moringa', 'sahjan', 'saijan', 'सहजन'],
  ['beetroot', 'beet', 'chukandar', 'चुकंदर'],
  ['beans', 'french beans', 'बीन्स'],
  ['cluster beans', 'gawar', 'guar', 'gwar phali', 'ग्वार फली', 'ग्वार'],
  ['broad beans', 'sem phali', 'सेम फली'],
  ['cowpea', 'chawla phali', 'chawli', 'lobia', 'चवला फली', 'लोबिया'],
  ['corn', 'sweet corn', 'makka', 'makki', 'bhutta', 'मक्का', 'भुट्टा', 'कॉर्न'],
  ['mushroom', 'mushrooms', 'khumb', 'मशरूम'],
  ['yam', 'ratalu', 'रतालू'],
  ['elephant foot yam', 'suran', 'jimikand', 'सूरन', 'जिमीकंद'],
  ['taro', 'arbi', 'arvi', 'colocasia', 'अरबी'],
  ['lemon', 'lemons', 'nimbu', 'limbu', 'नींबू', 'निम्बू'],
  ['raw banana', 'kacha kela', 'kaccha kela', 'कच्चा केला'],
  ['raw tomato', 'kacha tamatar', 'कच्चा टमाटर'],
  ['sweet potato', 'shakarkand', 'शकरकंद'],
  ['jackfruit', 'kathal', 'कटहल'],
  ['vegetable', 'vegetables', 'veggies', 'sabzi', 'sabji', 'subzi', 'सब्ज़ी', 'सब्जी'],

  /* fruits ---------------------------------------------------------------- */
  ['banana', 'bananas', 'kela', 'kele', 'keela', 'केला', 'केले'],
  ['apple', 'apples', 'seb', 'saib', 'सेब'],
  ['mango', 'mangoes', 'aam', 'आम'],
  ['orange', 'oranges', 'santra', 'santara', 'narangi', 'संतरा'],
  ['sweet lime', 'mosambi', 'mausambi', 'mosumbi', 'मौसंबी', 'मोसंबी'],
  ['guava', 'amrood', 'amrud', 'peru', 'अमरूद'],
  ['papaya', 'papita', 'पपीता'],
  ['pineapple', 'ananas', 'अनानास'],
  ['pomegranate', 'anar', 'अनार'],
  ['watermelon', 'tarbooz', 'tarbuj', 'तरबूज'],
  ['muskmelon', 'kharbuja', 'kharbooja', 'खरबूजा'],
  ['grapes', 'grape', 'angoor', 'अंगूर'],
  ['plum', 'aloo bukhara', 'alubukhara', 'आलूबुखारा'],
  ['gooseberry', 'indian gooseberry', 'amla', 'aonla', 'awla', 'आँवला', 'आंवला'],
  ['pear', 'nashpati', 'नाशपाती'],
  ['litchi', 'lychee', 'lichi', 'लीची'],
  ['sapota', 'chikoo', 'chiku', 'चीकू'],
  ['coconut', 'nariyal', 'नारियल'],
  ['dates', 'khajoor', 'खजूर'],
  ['fruit', 'fruits', 'phal', 'फल'],

  /* dairy & eggs ---------------------------------------------------------- */
  ['milk', 'doodh', 'dudh', 'dud', 'दूध'],
  ['curd', 'yogurt', 'yoghurt', 'dahi', 'दही'],
  ['paneer', 'panir', 'cottage cheese', 'पनीर'],
  ['butter', 'makhan', 'makkhan', 'मक्खन', 'बटर'],
  ['ghee', 'desi ghee', 'घी'],
  ['cheese', 'चीज़', 'चीज'],
  ['buttermilk', 'chaas', 'chhach', 'mattha', 'छाछ'],
  ['cream', 'malai', 'मलाई'],
  ['egg', 'eggs', 'anda', 'ande', 'अंडा', 'अंडे'],

  /* staples --------------------------------------------------------------- */
  ['rice', 'chawal', 'chaval', 'chaal', 'चावल'],
  ['atta', 'wheat flour', 'aata', 'flour', 'आटा'],
  ['wheat', 'gehu', 'gehun', 'गेहूं', 'गेहूँ'],
  ['besan', 'gram flour', 'बेसन'],
  ['suji', 'sooji', 'semolina', 'rava', 'rawa', 'सूजी', 'रवा'],
  ['maida', 'refined flour', 'मैदा'],
  ['dal', 'daal', 'lentils', 'lentil', 'pulses', 'दाल'],
  ['toor dal', 'arhar dal', 'tur dal', 'toor', 'arhar', 'tuvar', 'तूर दाल', 'अरहर दाल', 'अरहर', 'तूर'],
  ['moong dal', 'moong', 'mung', 'green gram', 'मूंग दाल', 'मूंग'],
  ['masoor dal', 'masoor', 'red lentil', 'मसूर दाल', 'मसूर'],
  ['urad dal', 'urad', 'black gram', 'उड़द दाल', 'उड़द'],
  ['chana', 'chickpeas', 'chickpea', 'chole', 'chhole', 'kabuli chana', 'चना', 'छोले'],
  ['rajma', 'kidney beans', 'राजमा'],
  ['sugar', 'cheeni', 'shakkar', 'चीनी', 'शक्कर'],
  ['jaggery', 'gud', 'gur', 'गुड़'],
  ['salt', 'namak', 'nimak', 'नमक'],
  ['oil', 'tel', 'cooking oil', 'तेल', 'ऑयल'],
  ['mustard oil', 'sarson tel', 'sarson ka tel', 'kachi ghani', 'सरसों का तेल', 'सरसों तेल'],
  ['mustard', 'sarson', 'rai', 'सरसों', 'राई'],
  ['soybean', 'soyabean', 'soya', 'सोयाबीन'],
  ['sunflower', 'सनफ्लावर', 'सूरजमुखी'],
  ['groundnut', 'peanut', 'peanuts', 'moongfali', 'mungfali', 'mumfali', 'मूंगफली'],
  ['almond', 'almonds', 'badam', 'बादाम'],
  ['cashew', 'cashews', 'kaju', 'काजू'],
  ['raisins', 'raisin', 'kishmish', 'किशमिश'],
  ['walnut', 'walnuts', 'akhrot', 'अखरोट'],
  ['pistachio', 'pistachios', 'pista', 'पिस्ता'],
  ['dry fruits', 'dry fruit', 'meva', 'mewa', 'मेवा'],

  /* spices ---------------------------------------------------------------- */
  ['turmeric', 'haldi', 'हल्दी'],
  ['cumin', 'jeera', 'zeera', 'jeeru', 'जीरा', 'जीरू'],
  ['garam masala', 'गरम मसाला'],
  ['masala', 'spices', 'spice', 'मसाला'],
  ['black pepper', 'kali mirch', 'काली मिर्च'],
  ['cardamom', 'elaichi', 'ilaichi', 'इलायची'],
  ['clove', 'cloves', 'laung', 'लौंग'],
  ['cinnamon', 'dalchini', 'दालचीनी'],
  ['asafoetida', 'hing', 'heeng', 'हींग'],
  ['fennel', 'saunf', 'sonf', 'सौंफ'],
  ['carom seeds', 'ajwain', 'ajwine', 'अजवाइन'],
  ['bay leaf', 'tej patta', 'तेज पत्ता'],
  ['tamarind', 'imli', 'इमली'],
  ['kachri', 'kachra', 'काचरी', 'काचरा', 'कचरी'],
  ['powder', 'पाउडर'],

  /* snacks, bakery, drinks ------------------------------------------------ */
  ['namkeen', 'namkin', 'नमकीन'],
  ['bhujia', 'bhujiya', 'भुजिया'],
  ['sev', 'सेव'],
  ['biscuit', 'biscuits', 'biskut', 'biscut', 'cookies', 'बिस्किट', 'बिस्कुट'],
  ['toast', 'rusk', 'टोस्ट', 'रस्क'],
  ['bread', 'pav', 'pao', 'double roti', 'ब्रेड', 'पाव'],
  ['noodles', 'noodle', 'maggi', 'chowmein', 'chow mein', 'नूडल्स', 'चाउमीन'],
  ['chocolate', 'chocolates', 'चॉकलेट'],
  ['sweets', 'mithai', 'मिठाई'],
  ['rasgulla', 'rasgola', 'rosogolla', 'रसगुल्ला'],
  ['tea', 'chai', 'chay', 'चाय'],
  ['coffee', 'kafi', 'कॉफी', 'कॉफ़ी'],
  ['water', 'pani', 'paani', 'पानी'],
  ['cold drink', 'soft drink', 'soda', 'thanda', 'कोल्ड ड्रिंक'],
  ['juice', 'jus', 'जूस'],
  ['energy drink', 'एनर्जी ड्रिंक'],
  ['papad', 'papadum', 'पापड़'],
  ['pickle', 'achar', 'achaar', 'अचार'],
  ['honey', 'shahad', 'शहद'],
  ['vermicelli', 'seviyan', 'sewai', 'सेवइयां'],

  /* household & personal care -------------------------------------------- */
  ['soap', 'sabun', 'साबुन'],
  ['detergent', 'washing powder', 'डिटर्जेंट'],
  ['dishwash', 'dish wash', 'bartan saaf', 'डिशवॉश'],
  ['toothpaste', 'tooth paste', 'manjan', 'टूथपेस्ट', 'मंजन'],
  ['shampoo', 'शैम्पू'],
  ['agarbatti', 'agarbathi', 'incense', 'incense sticks', 'अगरबत्ती'],
  ['matchbox', 'machis', 'माचिस'],
  ['broom', 'jhadu', 'jharu', 'झाड़ू'],
  ['hair oil', 'baal ka tel', 'बालों का तेल'],

  /* restaurant food ------------------------------------------------------- */
  ['paratha', 'parantha', 'parotha', 'पराठा', 'परांठा'],
  ['roti', 'chapati', 'chapatti', 'phulka', 'रोटी', 'चपाती'],
  ['naan', 'नान'],
  ['momos', 'momo', 'मोमोज़', 'मोमो'],
  ['burger', 'बर्गर'],
  ['pizza', 'पिज़्ज़ा', 'पिज्जा'],
  ['chicken', 'murga', 'murgh', 'चिकन', 'मुर्गा'],
  ['mutton', 'gosht', 'मटन'],
  ['fish', 'machli', 'machhli', 'मछली'],
  ['biryani', 'biriyani', 'बिरयानी'],
  ['roll', 'rolls', 'kathi roll', 'frankie', 'रोल'],
  ['curry', 'gravy', 'करी'],
  ['pakoda', 'pakora', 'pakode', 'bhajiya', 'पकोड़ा', 'पकौड़ा'],
  ['tikki', 'टिक्की'],
  ['samosa', 'समोसा'],
  ['kaleji', 'kalegi', 'liver', 'कलेजी'],

  /* clothing -------------------------------------------------------------- */
  ['t shirt', 'tshirt', 'tee', 'टी शर्ट'],
  ['shirt', 'shirts', 'शर्ट'],
  ['jeans', 'denim', 'जींस'],
  ['trousers', 'pant', 'pants', 'पैंट'],
  ['vest', 'baniyan', 'banian', 'बनियान'],
  ['innerwear', 'innerwaer', 'undergarments', 'underwear'],
  ['kurti', 'kurtis', 'kurta', 'कुर्ती', 'कुर्ता'],
  ['saree', 'sari', 'साड़ी'],
  ['jacket', 'jackets', 'जैकेट'],
  ['hoodie', 'hoody', 'hoodies'],
  ['sweater', 'swetar', 'स्वेटर'],
  ['kids', 'kid', 'children', 'bachche', 'बच्चे'],

  /* kitchen & home -------------------------------------------------------- */
  ['pressure cooker', 'cooker', 'कुकर'],
  ['utensils', 'bartan', 'बर्तन'],
  ['kadai', 'kadhai', 'wok', 'कड़ाही'],
  ['tawa', 'griddle', 'तवा'],
  ['bottle', 'bottles', 'botal', 'बोतल'],
  ['container', 'containers', 'dabba', 'dibba', 'डिब्बा'],
  ['glass', 'gilas', 'गिलास'],
  ['bucket', 'balti', 'बाल्टी'],
];
