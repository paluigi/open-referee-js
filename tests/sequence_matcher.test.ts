import { describe, expect, it } from 'vitest';
import { SequenceMatcher, similarityRatio } from '../src/util/sequence_matcher';

// ===== Python-generated expected values (`uv run python` difflib in the
// open-referee repo; PY_* repr pattern from tests/bibliography.test.ts).
// 26 hand-picked (a, b) pairs incl. unicode, punctuation, repeated tokens;
// the pinned ratio is difflib.SequenceMatcher(None, a, b).ratio() exactly.

const PY_PAIRS: [string, string, number][] = [
  ['', '', 1.0],
  ['', 'abc', 0.0],
  ['abc', '', 0.0],
  ['abc', 'abc', 1.0],
  ['abc', 'abd', 0.6666666666666666],
  ['abcd', 'abce', 0.75],
  ['kitten', 'sitting', 0.6153846153846154],
  ['abcdef', 'xbcefg', 0.6666666666666666],
  ['the quick brown fox', 'the quick brown dog', 0.8947368421052632],
  ['aXbXc', 'abc', 0.75],
  ['aaaa', 'aa', 0.6666666666666666],
  ['aaabbb', 'bbbaaa', 0.5],
  ['flibble', 'fribble', 0.8571428571428571],
  ['héllo wörld', 'hello world', 0.8181818181818182],
  ['café naïve', 'cafe naive', 0.8],
  ['日本語のテキスト', '日本語テキスト', 0.9333333333333333],
  ['münchen', 'munich', 0.6153846153846154],
  ['a, b; c! d?', 'a b c d', 0.7777777777777778],
  ['proceedings of the', 'proceedings of the acm', 0.9],
  [
    'statistical learning theory',
    'the theory of statistical learning',
    0.6557377049180327,
  ],
  ['machine learning (2001)', 'machine learning 2001', 0.9545454545454546],
  ['foo bar foo bar', 'bar foo bar foo', 0.7333333333333333],
  ['ABCDEF', 'abcdef', 0.0],
  ['ab cd ef', 'ef ab cd', 0.625],
  ['x', 'x', 1.0],
  ['%.2f and (0.72)', '0.72 and 2f', 0.6153846153846154],
];

const PY_FUZZ_PAIRS: [string, string, number][] = [
  ['e日d本語b. o.語c語rl本ceo.  éb ü', 'oaraw lüérbtcl本eecü', 0.26666666666666666],
  [
    'é日dcd.b . eal本e  ül ro,..o本e日l日本üwlba,or',
    'é日dcd.b .w eal本e  ül ro,..o本,e日l日本üwlba,or',
    0.975609756097561,
  ],
  ['l本d本dw.', 'e日本wé本ebcled日rllü本lr語bbr本本e,', 0.17142857142857143],
  ['d本r,ob本,éb.bt日,ü trel ', 'd本r,ob本,éb.bt日,本ür trdeü ', 0.8936170212765957],
  ['語lta語lald語', 'lc語la本ld語', 0.7368421052631579],
  ['..本rewo語ewo oélra c語,,.wdéoe,本', 'woéllad 語üldrc語l語d', 0.3333333333333333],
  ['w.d語bwl日tltd,elc日.üat,', 'w.dr語bwl日 td,elc 日.üat,', 0.8888888888888888],
  [
    'd ld wltoolt日ücctlbb 語ae語 letbé.l',
    'd ld wltoolt日üccllbb  ae語 letbé.l',
    0.9393939393939394,
  ],
  ['ll,,ü', 'lrl,,ü', 0.9090909090909091],
  ['üwü  ', ' do b.,od語,語a c本,l.acéw bebd本lbüwaét', 0.0975609756097561],
  [
    'alü日wb ccat,olbwort日,e日,語 a ',
    'a本rdrdtt本ebeb本r .語b語llt日r日語oél本cl本rl ',
    0.24615384615384617,
  ],
  ['b,ü.rladl.édel.oc', 'b,ürladd.cdel.o', 0.8125],
  [' erwbalüa日 üb語rlw本d.éal', ' erbalüca日 üb語r本d.éa日l', 0.8888888888888888],
  ['co.l.o語cbl本.dlée本ew本é日', 'co.l.o語cbl本dlée本ew本日', 0.9523809523809523],
  ['we本語ülo語 t d, ', 'we本語ülo語 語 ld日, ', 0.8666666666666667],
  ['c語lüa本d.本ülté r ', 'b', 0.0],
  ['l本日eoc crbü cc ü', ' .l raw o日本td', 0.13793103448275862],
  [
    '日ecab ld本lttédr本od本日dde.  l é語本e語日ü',
    'llüc日r日ww,語lobd .c',
    0.07547169811320754,
  ],
  [
    '  wardlt語 b語ob 本ü.lb本.r, ca日l,r , e',
    'ocdtrbt.eü.語é oooé語 .dwwa w',
    0.0967741935483871,
  ],
  ['.', ' ', 0.0],
  ['ll日éélü日e erü', 'll日éélü日e lü', 0.88],
  ['b本wél語l日.eb', '本wwalc,', 0.3333333333333333],
  ['rütüa.lt', 'édd tt,語oül,語br 日lbtwlb日oc.,üod語d', 0.0975609756097561],
  ['日ltwaddtrcdr.e  cetoedlüd日e,éd.', 'éb', 0.06060606060606061],
  [
    'dcacü語 o日本r,語ddwb 本bawd 語t ad.rr',
    'dcacü語 本日é本r,語ddwb 本b本wd 語t,d.rr',
    0.875,
  ],
  ['d語 本ld 語d,c .é d,.本', 'ü  aoé,d語ll leltd日日  cl', 0.3333333333333333],
  [
    'codtoedü語la語a,btü本語. aoédl日é語alwbcddtw',
    'codtoedü語la語a,btü本語. aoédl日é語alwbcddütw',
    0.987012987012987,
  ],
  ['llet語o.düdübcwal語rt tto,él dr日.', ',.üowdaeeob日c . cté日', 0.1568627450980392],
  [
    'l本 ttwéeldtüb日d語,.üto日ü ürü',
    'l本ttwéldtüb日d語,üto日ü üréü',
    0.9230769230769231,
  ],
  [
    '日 .語lddtrdaü llb,rüc.dlae語é語adw.日.日d',
    '日 .語lddtrdaü llb,rüc.dlae語é語adw.日.od',
    0.9722222222222222,
  ],
  ['boe本w dacelbr語 wrcwb', 'bodb本ücdw本bar déteo,語語日ale ', 0.3829787234042553],
  [
    'ldlér 語b語.becoo語w.,d dc日d本ll,é.,éleüoba',
    ',日ü語日本l.r 本w,d日éb . etlél,ü,aw.l,ct語ccl,',
    0.22784810126582278,
  ],
  ['r.日l日lr語teowl é', ' érodlü,e lld', 0.14285714285714285],
  ['d ,語wlblledlrülb日d,', 'eb日 w日d日o ', 0.27586206896551724],
  [' drddclo日tlclüblbrddat 日,l日l日,c.,rw.lre', 'c日eb a é', 0.1276595744680851],
  ['wbloco', 'dal日co', 0.5],
  ['llü本d 本cd語oa', 'we. dd日édortlü日本lwéaé,breé.lr', 0.1951219512195122],
  [
    '語 t..a日t é.daadé本本.l語él,日dü',
    'r. bw. éal日語 lr本eéblreda語ac',
    0.2222222222222222,
  ],
  ['語d,t.語acd lrtc,,本o語日rcür r  ', '.語 l語a ürdroücéa.日', 0.34782608695652173],
  ['ldüb d', 'ldüb o語', 0.7692307692307693],
  [
    '語lé日日lürdül本wüaüdo本eo日. c日üé本dbr',
    ' l本,本 日td語é.,dobl,日ad語ürw  ',
    0.23728813559322035,
  ],
  [
    'db,..本éwow ocl üboo本ü  éecl',
    'db .d本éwow ocl waboo本aü  éecl',
    0.8571428571428571,
  ],
  ['語a日oaeloll', '語a日o日a eéwl日ll', 0.75],
  ['   w', 'td,co語d l日oétta.r .ree,.ldélrd', 0.11764705882352941],
  [
    '語a本le,語taü語büaa  édew.',
    'ü.dü wedoctb語ol本wül ,日eét,ed語dt.ül',
    0.2857142857142857,
  ],
  [
    'cü,l lc 本,éd w,日ae üüb,語otér',
    'cü,l 語c  本,éw,日ae üüb,語otér',
    0.9090909090909091,
  ],
  ['ü é d ,o.,e本cbc語r.llbob  .r', 'ü é d,o.,e本cbc語r.llbob  .r', 0.9811320754716981],
  [
    '本wl b.é .本ütaaw日ütw,本o本日d語d.dlüré,t語',
    '本wl b.é .本eaaw日ütw,e本o本日d語d.dl日üré,t語',
    0.9315068493150684,
  ],
  ['do  loeoü.l日ü.dwücl.l', '日日étwce語bé 日l,', 0.11428571428571428],
  ['r wl ,a日t本日', 'lwdd日üwü,ü日e本l .,, w日ltb 語lowéaw', 0.23255813953488372],
  ['日語w語ü語eb é.o語 本ér', ',語w語ü b é o語 cér', 0.7272727272727273],
  ['btr   日btlw語c.ll.', 'trw  o日btla語.ll.', 0.7878787878787878],
  ['ldé本語o', 'él語o', 0.6],
  [
    'dül oweré本eb日cd céé .日l.awtcd.l,o',
    'dül oweré本eb日cd aéé .日l.awtcd.l,o',
    0.9696969696969697,
  ],
  ['eecé bodéa cbtdbe日réwéad.d,oa ,é,w', 'd語üd 語ü日d ', 0.13636363636363635],
  ['clrlbl', '本adc語 b.ol日tlta日..t. oté,日語tdod,d日b', 0.1951219512195122],
  ['lol', '語bldl', 0.5],
  ['eb本rc日 ed日 . .ü', 'eb本rc日 ed日 ..c.ü', 0.9032258064516129],
  [',atb, lcdte.üe日b', ',atb,wlwcdte.üe日rb', 0.8823529411764706],
  ['woa語ü語日toal ', 'r日ülr語o ra 本 üdl日oolt本r', 0.2857142857142857],
  ['w', '本w', 0.6666666666666666],
  ['本üéél ,ledwe', '本üél  ,ledwe', 0.9166666666666666],
  ['wé,,c', 'é,,d', 0.6666666666666666],
  ['t本w 語r', 'tw  or', 0.6666666666666666],
  [
    'bülé eedéacaedta c語.ütoü日becür日o ',
    'bülé eedacaedta c.üto,日becü日o ',
    0.9206349206349206,
  ],
  ['.é.日b日d本dü', 'ééo,becleéül ü  rwtc éd', 0.18181818181818182],
  ['. üe oüe本.allaéb', '. üed oüe本.alléb,', 0.9090909090909091],
  [
    'e本 e wr語 ü.wbéworww raü本w日.,é oa l,ld ',
    ',ee本edl日rlütl語',
    0.19230769230769232,
  ],
  [' o 語 ebec.r', ' rb語bdct ld  é,,bdü d', 0.25],
  ['bdoo .日twc', '.bdolcüt', 0.4444444444444444],
  [
    'ldtw,oa  日ücw, d語a d t,é,tbd',
    'ldtw,oa  日ücw,日da d t,é,tdd',
    0.9090909090909091,
  ],
  ['oa語日lüddl w ,t日elbc d', ' .d,,la,lrrcl日laoab.本', 0.14285714285714285],
  [
    'b  o.ldw,e,ddrütad本old   üecaddl,cw日',
    'éébddb,ldo 本  e,dabred aetrw語dol, 本b.l,',
    0.37333333333333335,
  ],
  ['ew日la loür,語本語t.', 'ew日la o lo語r,語本語t.', 0.8823529411764706],
  ['本b.d日lw', 'b.日l.日w', 0.7142857142857143],
  ['l', 'le', 0.6666666666666666],
  [
    'lébt, co日düé本o日本d語d rl dwa本e本ü',
    'lébt,rco日düé本o日本d語d rl dwa本e本ü',
    0.9666666666666667,
  ],
  ['l 本r本dwbo. ,ata語日ddr語.', 'l 本rc本dwbo. ,at 語日ddr語.', 0.9333333333333333],
  ['llerlaaddéo  o語ew lo 本語cü', 'llerraddé,  o語ew lod本語cü', 0.8571428571428571],
  [
    'w日bc é üü d日o.tü lobl ,rb,üc ,w語',
    'w日c é üü d日o.tü lobl ,rb,üct,w語',
    0.9523809523809523,
  ],
  ['at語', 'tdo日日téoodwtdcd.本lbt. wd語 語c本c.ür語', 0.10810810810810811],
  ['ddl', 'l', 0.5],
  ['日lwbéüébc日w 日l tta,üülda', '日lwbéüébc日w 語日l ttcc,üülda', 0.92],
  [' lclad.日,a日ü本e ld. r', ',c本tr語語.日l日.w.,ato', 0.2631578947368421],
  ['a日ü語tér..本aetrüw.d', 'r.w w déda .é語', 0.1875],
  [
    'üébllc tél.dlt éoüédl語l語日bet',
    'üé llc tél.dlt éoüédl語l語日bet',
    0.9642857142857143,
  ],
  [
    '日 o日 本本日büaw日d語l eced',
    'edcd 語語é語日é lada,üb 語d語a',
    0.2222222222222222,
  ],
  ['l語éücbt本lcltéww日.é deüoüc e', 'é,  l本', 0.12121212121212122],
  [
    '本日ddtdélbc本l日rwleüoo a,ct語',
    '本日ddtdélbc本l日rwledoo a,ct語',
    0.9615384615384616,
  ],
  ['dt本lléce語l,tw本oe本bdd', 'd,t本lléc語l,tw本oe本bdd', 0.95],
  ['語rldébdlbr ltl  aw語edl.l.', '語crldéwlr ltl  aw語edl.l.', 0.8979591836734694],
  ['wblo', 'bc日owl lüaweoüw.t ü  taüb', 0.13793103448275862],
  ['ctüaüoedr,.語c本rt b日 r r', 'b語le,eo日 lb ,dd  üe日.本.', 0.17391304347826086],
  ['語é本 ra,dw本本,wlcba.日', '語é本 a,dw本,語lcba.日', 0.8888888888888888],
  [
    'l.l語.本étd語cbt ,日',
    'é oréert本oa語atlü,a,r語üalcéd 本bl語.üd 語da',
    0.21818181818181817,
  ],
  [
    '日,dwüa,ü語lbülüü.本本ü本éwl本語 ,él',
    '日,dwüa,ü語lbülüü.本本本éwl本語 ,él',
    0.9824561403508771,
  ],
  ['düdlwc日日cl bod日r日', 'lc語d語aoer dod日tllbr. ,e,cé bado', 0.25],
  [
    '日céd本 a,üdé 本ü本.語 b語 cé',
    'lte oewr本 .lddddlble日本odeéell日w',
    0.14814814814814814,
  ],
  [
    ',,dll日  w本e 語c語.日d日,ül,te本t日cl',
    '.語éü o語beéa.c日ottéü.db,eo.dtodeü語c e',
    0.18181818181818182,
  ],
  ['日eawtü e dtdtb rbtrdd', '日eawtlü d dtdtbrbtrd', 0.8780487804878049],
  ['語dt語本dé', 'l 本w.語.r  語a 語o l日c', 0.15384615384615385],
  [
    'a,wdleoo c wc',
    'c a日ea本üt ll.adowa.本,.語c語,t語語éwltdlw.üü',
    0.23076923076923078,
  ],
  ['aé本aü日rdddwd c本drl', 'aé本aüerdddbwd ct本dl', 0.8648648648648649],
  ['éawébb,rr,o.darr語,tüttdtr日a tt', 'tl.本語r', 0.05555555555555555],
  ['dr本lüao日l日 a.ll bdbw  e日éü語rd日.art', 'lcü語b本odlo.w,c本r.t,ée.drbc', 0.1],
  [
    'lbdclüdab,r .éét laü本.語語,lt,日  r ,',
    'lbdclüdab,r .éét laü本.語語,lt,日  r r',
    0.9705882352941176,
  ],
  ['oorlü', '.lddl,a ae.tdda lcw本dw本r  .o', 0.06060606060606061],
  ['', '   日obcé,e l', 0.0],
  ['éwü llb日o.éect, 本r日', 'éw本ürllb日o語.éct, 本r日', 0.8717948717948718],
  ['cbülüürlé,éleaé語t  b, é', 'cbüüürlé,éleaé語t.  b, ', 0.9333333333333333],
  ['rat語ed語ülcctbbw日 本e l.wba日e, r', 'awcoc d本dwb aodü', 0.2608695652173913],
  ['日日üwla本wüwt日語本日ér語d wecl,,dcodbw.l日é語d', '本l w 本drceüd', 0.2],
  ['rü.w本 looball語ll語wa aad語', 'rtü.w本élooballll語a aad語', 0.8936170212765957],
  [
    'e.,er日ctacarwé lo日t語日dobtrétreü語',
    'e.,er日ctacarwé loét語日dobtrétreü語',
    0.96875,
  ],
  ['üdbd  l日tlrbül', 'ü,dt日édé日,日語c. w本,clbt語rbe本lae本語r', 0.2978723404255319],
  [
    'tttdtt本eé.r語a.lbd本r本wc . t語üücdoü',
    '語üéloe日cwoéw本ddcd.語本a.é',
    0.14285714285714285,
  ],
  ['ac.tad日l düd', 'wc.tdado日ldüd', 0.8],
  ['本er.ocü.日léaolbooa,ecl.e語o', '.atdll bl', 0.2857142857142857],
  [',.,lcaéb', 'raw,本dd b,b,語t日rdar語d本é日本al語éd', 0.21052631578947367],
  ['dübrbwl dc cl,.', 'dübrbol dc c,,.', 0.8666666666666667],
  ['wt...llétbl,ü本b日a', 'wt...llétbl,üb日wa', 0.9411764705882353],
  [
    'dtdblüeeel語cl,rüo日éll.rét本 ',
    'dtldblüeeel語clw,rüo日éll.ré本 ',
    0.9454545454545454,
  ],
  ['lra,l.', 'ld ,lü', 0.5],
  ['ocdé語rü', 'ot cd.e', 0.42857142857142855],
  [',c  cc d語or日, 語tüwüa日cw 本r語wdd', 'r ', 0.0625],
  ['é', 'r', 0.0],
  ['b語 dr語üld本 b日 d l,,ütbl,a wabw', ' 語t日éltwüe ea,üllrdwéédéeü', 0.25],
  ['w語o r.cwed本ü', '', 0.0],
  [
    'et本boldw w語dé日.dé本.o,,日c語daéüé',
    'et本btldw w語lé日.dé本.o,,日c語daéüé',
    0.9333333333333333,
  ],
  [',,léaldü', 'éé.', 0.18181818181818182],
  [
    '日wd .語wtüd .語w本üccü日.t ol',
    '日wd .語wt語üd .語w本üccü日.t ol',
    0.9803921568627451,
  ],
  [
    '本bdlo  l日本語日 aéccl語é日l ',
    'l.r  日l日oc, cw,.dwt,lé.,d wwl語üw',
    0.32727272727272727,
  ],
  [
    ' ,c本 bl.本dw日ot tcéreb 日 é.d.eür本oaadlta',
    ' ,c本 ,l.本dw日ot tcéreb 日 é.d.eür本oaadlta',
    0.9743589743589743,
  ],
  [
    'dwü  obra w.dl日ad日rbol lbbt,,wcebdaaodow',
    '.e日 w  bwelrd語 a日d.üébce.t',
    0.30303030303030304,
  ],
  ['dd語,ül本w élédür本e t ', 'dd語c,ül本w élédür本e t ', 0.975609756097561],
  ['té日édb  ', 'ob.日éü語c語wd日ol,übb ,w', 0.3448275862068966],
  ['waerc   ctw .lül  ddb', 'waerc   c語w .ül  ddob ', 0.8837209302325582],
  [
    'oawl dbrrüdr日 語語la rü.weüor.rw',
    'awl dbrreüdlr日 語la rü.weüor.rw',
    0.9333333333333333,
  ],
  [' eéortédwé日cü本本,wc', ',tdé,,dl本b.olcc.語b blob, d.écrüwl', 0.1568627450980392],
  [' üdcérct 日lét語br 語éwl üoab', ' tcérct 日ldét語brb語wl üoab', 0.8627450980392157],
  ['trlrb.t e本', 'ctlrb.rtto', 0.6],
  ['tcc  el.wo   b.o b l', 'tccel.wo   bwo bl', 0.8648648648648649],
  ['eéb', ',ü,,.,wé語at語語 e', 0.1111111111111111],
  [
    'ldd語本d r 日本 c,bal,od日üérl語oédrbl,ü',
    'lddd語本a r 日本 c,bal,od日érl語oédrbl,ü',
    0.9411764705882353,
  ],
  ['r 本e語ttéa日ellb本日日üla.eo 語', 're語ttéa日ellb本日日ülae.eo 語語', 0.92],
  [
    '日cétbc ate本d語al ct,tb語本日tr 日bd',
    '日cétbc. ate,本d語al dt,tb語本日tr 日d',
    0.9180327868852459,
  ],
  ['e日bweoadbdadwola,ü本,', 'l ra日la loa éde ladd語d .', 0.2727272727272727],
  [' 本do', '語語本本.語wé.o本abol', 0.21052631578947367],
  [',語', 'aüctrll.c本e.,üacé l語l e本bll日b', 0.12903225806451613],
  [
    ',bellcl dlbebod. dwlcw,bae日é weü',
    ',bellcl dlbebod. d語wlcw,bae日é weü',
    0.9846153846153847,
  ],
  [
    'a.aé,r語e語é.日rtéba日lddlrr日本ew',
    'lb語dw dlooddltüoo lüc語d.éo本b.dtcée',
    0.22580645161290322,
  ],
  ['ta.rwre oe.d本', 'eérbto,clbo日rwrbd b日clt,édl  ,é', 0.2727272727272727],
  ['b語語本l,語c 語ldel,dla', 'b語語日l日語c eldelcl', 0.7058823529411765],
  [
    'woddalr éd éate,é wcc a本lrcdodéa',
    '日 ü dtülcl c,to,ebüoa ü本',
    0.14285714285714285,
  ],
  ['o crc', 'ért ta本語o b語語.üücbd 本w,oe lt本', 0.17647058823529413],
  ['', ',lüe', 0.0],
  [
    'éadc語t本d日e.本c ttel ü語cr.ero語',
    'éadc語t本d日.本c ttl ü語cr.e日o日',
    0.8888888888888888,
  ],
  ['wd  r本w本teetb, cü,lle本', 't語clelclo üol日語üwal日ell', 0.17777777777777778],
  [
    'loael語ebedcü.b語td本本adwd. ',
    'lloaee語ebedcü.b語td本本adwd. ',
    0.9411764705882353,
  ],
  [
    'wabrré oü本d,érüc日.語dde.t.日ao,clw',
    'waré oü本d,eérüc日.語dde.t.日ao,clw',
    0.9523809523809523,
  ],
  ['ll 本e本本w tt.c.r', ',eo語daoaa,tt .a語', 0.25806451612903225],
  [' l語本ldtd .eübt日 oolcrl', 'teawcwdllw', 0.125],
  ['本a日ü ', 't本a日a', 0.6],
  ['d,üet語dd本dc a,', 'd,üet語dd本dct la,', 0.9333333333333333],
  ['lddbüwwltllo本日l本l', 'bb 本.t語rtlc日本', 0.26666666666666666],
  ['ltlüll,éüdücl日r.bü 本a', 'tlüll,é語dücl日r.bü 本a', 0.926829268292683],
  ['r üo', 'ré wü日', 0.6],
  [
    'céréaw本日.日dcd. ebll本 üa übe',
    ' cwreab,cwtaédorc,üodebbd oo .  clec本',
    0.28125,
  ],
  ['語d.aéce本read, 日 語語,r.d de,', '語d.aéc本read, 日 語語,.d語 d,', 0.92],
  ['l,daléed', 'w日ü.,bbwccéet', 0.2857142857142857],
  ['lrbbeéalelrcdl dlrwe,,t本', 'lrbbeéalelrcdl dlrwe,,本', 0.9787234042553191],
  [
    'dloeodod d eleléato,,l日語,büldé.,日cr',
    'doeodod d日elelléato,,l日語,büld .,日r',
    0.8985507246376812,
  ],
  ['é', 'cb', 0.0],
  ['本üo語d日 c. 日l ü日rr', 'rlalod', 0.17391304347826086],
  [
    '日tw本lwwl.rcweateéldod日l ,re',
    '日tw本lwl.cweéteéldod日l ,re',
    0.9230769230769231,
  ],
  ['waa', 'wa a', 0.8571428571428571],
  [
    'bld本本 語 e  .本wébe語cbér.dé, rcwdottrr,',
    'rwd語aa本crü .ate  drrbl本.dc',
    0.31746031746031744,
  ],
  [
    'd本.at 日,ü drwlo l本本d e. 日日d語',
    'd本.dat 日,ü rwl l本本d . 日日d語',
    0.9259259259259259,
  ],
  ['l.本wdüe tor wle本ét,rrl', 'l.本wdüe tor ole本ét,rrl', 0.9545454545454546],
  [
    '日.o le,tllct本dt,. .語lret  ',
    '日.a lr,tllcé本dt,. .élret  e',
    0.8301886792452831,
  ],
  ['tüdl roééc cbbl', 'tüél roééc 日cbbl', 0.9032258064516129],
  ['rdétcü a dcc本o本el,redtaceé日lwl', 'rdétcrü ae cc本o本日el,rdtaceélwl', 0.9],
  ['dwtl,éo,w本a語dlel,érüé .', 'dtl,éo日w本語 dlel,arüé .', 0.8444444444444444],
  ['l', 'él', 0.6666666666666666],
  ['本ae,c', '日cütod本語dl.bcaü語', 0.19047619047619047],
  [
    ',d , c.,cr語büt .ta語 d ü lt üddl o',
    ',d , c.,c語bü t .ta語 d ü lt üddl o',
    0.9696969696969697,
  ],
  [
    ' ,d,日ocré ccoa.bc日we日eü,ee.b',
    '.ldlt語語語本cé日o.r cwtw本c tcoür',
    0.32142857142857145,
  ],
  ['語écüd,日dbr ütoobde.o本,é.bléldl  ', 'loo,b', 0.16216216216216217],
  [
    'lbt ülw dtr日rédlrd trd本teacdr dtédw日t,',
    'lbtülw dt本日rédlrd trd本teacldr dtédw日t,',
    0.9473684210526315,
  ],
  [
    '.eütwdeü od日béleoralo 本l語de.l語w語edl ow',
    '.edtwdeü od日béleorelo 本l語de.l語w語ed l ow',
    0.935064935064935,
  ],
  ['r語tdwl語beüd本 écdl本 日co 日trrrdwd d élwlod', 'éa本', 0.046511627906976744],
  ['üt本 ,,a,l ea é crdcwcéadb ü', 'üt本 ,,a,l ea é .crdcwcéadb ü', 0.9818181818181818],
  ['bllr  ', 'üdü.d日,wrocdwd cdwla本 .cdl', 0.125],
  [
    'üwe日eéea  éloüé語td本 llelo  日,ebtd日l日本語cc',
    'üwe日eéea  éloüé語td llelo  日,ebtt日l日本語cc',
    0.9620253164556962,
  ],
  ['bl語e 語語éré,', '', 0.0],
  ['日本r', 'l日本d', 0.5714285714285714],
  ['tcol日d本bb,本d,.ll', '語blo,a 語e', 0.16],
  ['d a,üeüwtél..rl語 ', 'd,a,üeüwtél.rl語 ', 0.9090909090909091],
  [
    '日.,dd語l  語,ü.dec  w語dclé',
    ' cbba  rd l d語üo本al日日d ütee本wb',
    0.2962962962962963,
  ],
  [
    ',üwé本lé, 本a  bwa o日o.ee   aw,,bdw本 eaüal',
    'wüdücb日ccl ll日本tdbüü本.üc 日 本l,üatü日',
    0.10666666666666667,
  ],
];

describe('SequenceMatcher (parity with difflib)', () => {
  it('ratio() matches Python exactly on 26 pinned pairs', () => {
    expect(PY_PAIRS.length).toBeGreaterThanOrEqual(20);
    for (const [a, b, expected] of PY_PAIRS) {
      expect(similarityRatio(a, b), JSON.stringify([a, b])).toBe(expected);
    }
  });

  it('ratio() is memoized like Python', () => {
    const sm = new SequenceMatcher('kitten', 'sitting');
    expect(sm.ratio()).toBe(sm.ratio());
  });

  it('getMatchingBlocks ends with the sentinel zero block', () => {
    const blocks = new SequenceMatcher('abc', 'abd').getMatchingBlocks();
    expect(blocks).toEqual([
      { a: 0, b: 0, size: 2 },
      { a: 3, b: 3, size: 0 },
    ]);
  });

  it('empty vs empty is ratio 1.0 (Python convention)', () => {
    expect(similarityRatio('', '')).toBe(1.0);
  });

  it('findLongestMatch picks the earliest of equal-length blocks', () => {
    // Python: ties go to the first (smallest i, j) match.
    const sm = new SequenceMatcher('abab', 'ab');
    const m = sm.findLongestMatch(0, 4, 0, 2);
    expect(m).toEqual({ a: 0, b: 0, size: 2 });
  });

  it('200 fuzzed pairs match Python exactly (seeded mutations incl. unicode)', () => {
    expect(PY_FUZZ_PAIRS).toHaveLength(200);
    for (const [a, b, expected] of PY_FUZZ_PAIRS) {
      expect(similarityRatio(a, b), JSON.stringify([a, b])).toBe(expected);
    }
  });

  it('handles repeated tokens symmetrically with difflib', () => {
    // aaabbb vs bbbaaa: two length-3 blocks -> 2*6/12
    expect(similarityRatio('aaabbb', 'bbbaaa')).toBeCloseTo(0.5, 12);
  });

  it('works on astral-plane characters as code points (surrogate pairs)', () => {
    // Array.from iterates code points; Python 3 strings are code points too.
    expect(similarityRatio('𝐀𝐁𝐂', '𝐀𝐁𝐃')).toBeCloseTo((2 * 2) / 6, 12);
  });

  describe('autojunk (Python default, review F1)', () => {
    it('applies popular-element junk for len(b) >= 200', () => {
      // CPython: SequenceMatcher(None, a, b).ratio() with autojunk ON — the
      // popular 'word ' elements drop out of b2j, giving 0.9132427...;
      // autojunk-off would return 0.9406...
      const a = 'word '.repeat(44).slice(0, 220);
      const b = ('word '.repeat(40) + 'zebra '.repeat(3)).slice(0, 220);
      expect(new SequenceMatcher(a, b).ratio()).toBeCloseTo(0.91324200913242, 12);
    });
  });
});
