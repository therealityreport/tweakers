/** The reviewed Accounts hooks carried by a derived desktop payload. */
export const ACCOUNTS_NATIVE_REQUIRED_HOOKS = [
  "account-menu", "profile", "apps-plugins", "mcp", "usage", "thread-summary",
  "query-scopes", "signal-query-scopes", "mutation-scopes", "native-browser-home", "native-browser-consumers", "native-project-state", "http-requests", "config-scopes", "requests", "profile-query", "usage-query", "reset-read", "reset-consume",
] as const;

/** Unmodified official 9922 companions authenticated at preparation and startup. */
export const ACCOUNTS_NATIVE_9922_COMPANIONS: Readonly<Record<string, string>> = {
  "webview/assets/local-conversation-thread-f8327c905ea9.js": "169c17646cb2c6f906f0b48eeb374c7564a525b240285e83a437fa98773b98a9",
  "webview/assets/local-conversation-thread-turn-entries-cfb6c7641138.js": "e8950eaef00045a1bdec9b8f720895265253832bb4e9c01b6cf94a0e3853b993",
  "webview/assets/plugins-page-section-fd67748f7b50.js": "90cdf90d9bc8e9087ffa92fc808266c3ec4b6a29ca994d20fd1fd1ca133944a4",
  "webview/assets/profile-lock-bbe1ace3e7b9.js": "963d686550d27081fdbc2a33d43490d9060b3b50fd2c392886c765fbb9663fe9",
  "webview/assets/profile-page-35bcbb29571e.js": "b16a2dce4dae8fefbaf3d584a2bfc8ca26c817a8b1cf8c41ba3060bf762b0259",
  "webview/assets/profile-settings-877920a2e831.js": "f83ecab33696d2e2a92e46c4e21987241ff5a21b200c4bbdffa89752aca444eb",
  "webview/assets/profile-settings-a8f55d5c9f38.js": "f09d3f5c00bde249531fceb5d0d9d5a2d401d58006843eb3efb058a21c7ffc1d",
  "webview/assets/profile-state-6eb6ff226ae8.js": "143e6c3a54c5b4b63cbdc35038bb92c85d78fcebe7a02c1dd3a4d92c51fe115b",
  "webview/assets/profile-state-9f803fee788a.js": "6d9dbbd5a57ec5a05d93e7e203bfb9cd07a82890ad03a9f3da3eeb6dc3a95afd",
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
};

/** Exact unmodified companions for the reviewed shared-query desktop builds. */
export const ACCOUNTS_NATIVE_10492_COMPANIONS: Readonly<Record<string, string>> = {
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
  "webview/assets/local-conversation-thread-355436b19ab3.js": "8088841975c28bbd5bd8568cfab5c02e420e7f8348ab4b1f1f2143785264cc6f",
  "webview/assets/local-conversation-thread-turn-entries-6a5bb414a409.js": "464c9d762d4a474eaa219c7d8579b5caf14bf838d5979383e666edfa342f5ec5",
  "webview/assets/plugins-page-section-ac20f8fbfc20.js": "29148ac1d1fb66985c3b9313d07dbd2fcb1c2103bead19c3973039c6454c600a",
  "webview/assets/profile-1e06c8c51352.js": "cdcea52b8336b58db55becbef6ea69a3247e61c06087eb2281933936cf6192e2",
  "webview/assets/profile-lock-9c199546f874.js": "583e6c98b3237ae67d2af3e53732d9d46cd54120175c6166a98cf0a8e63c0f53",
  "webview/assets/profile-page-23034681dec6.js": "400ea7df43bce499789c9d4840704a46eb49927e11425abcf6891a507664a322",
  "webview/assets/profile-settings-60f2fec7f1ff.js": "6a708b6bcf5da8242df34cc72e911a7fb5d34d94c8fc74bf48141d6b090ec787",
  "webview/assets/profile-settings-71e58d5c9d69.js": "972840afdc3a429f77795dcb20752a88ab97f38f33bcfef76e5f17403efcf200",
  "webview/assets/profile-state-11029b8208cb.js": "9d39684a61a6c37b3472966fc5e68ddcaaf108bd2c0727d3ca424a73a87735fc",
  "webview/assets/profile-state-bde4f4cada39.js": "8b74ed5399534ae309453ffb3e63a744acda1d80e1d842f04f2fb8d70212e567"
};

export const ACCOUNTS_NATIVE_10640_COMPANIONS: Readonly<Record<string, string>> = {
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
  "webview/assets/local-conversation-thread-3eb53798d2ab.js": "4bd6c4274317486d8c9c8e5fd559b5e808713f728be5120e807c3e42df2cf5a7",
  "webview/assets/local-conversation-thread-turn-entries-344cea102142.js": "282b67f8dc879205c63442a9bd1f10ef8f7b5b05256878af8af604b9eb730b86",
  "webview/assets/plugins-page-section-835eafaf343c.js": "703139e16b28383a0264ffac46abd59c3ff751e2e6ff6d42fac0ff33b2a408fe",
  "webview/assets/profile-fde366889a7f.js": "42fc6c2404031e7a60f72bf227d784fed0f27e532c2c9f11bd8ef251cc84170e",
  "webview/assets/profile-lock-3fd8b645eca8.js": "6b8d9b681fddaf0a135ec8d099b5026536b732cb910a7fc20e7f9b725aa925e4",
  "webview/assets/profile-page-197a09ff390f.js": "bb8e59aa7d91ec4ad838e283574ffc136a6e8790fd6598180b48b745bfe4a602",
  "webview/assets/profile-settings-28ac9cff8de1.js": "74d2fa35e842c3c63c67a412211218babf193f958b3a6b06a286b3d47e560570",
  "webview/assets/profile-settings-c62c5baef7b2.js": "ea059b1f07f1eb6f7e7fe4d0af79afd6ae53c6843b43c4bc9e9981456dba9847",
  "webview/assets/profile-state-19a9c0d994c5.js": "a5917bdb0f557a3041b8d85dda3f8d23bfd4bc5211060440588b0ba5d3a3f397",
  "webview/assets/profile-state-2fc81baa664a.js": "73161d4c505c4b7b70b10a03712177dd187f0f5faafa91e41f1d1e7d74683561"
};

export const ACCOUNTS_NATIVE_10954_COMPANIONS: Readonly<Record<string, string>> = {
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
  "webview/assets/local-conversation-thread-3ea57655efd1.js": "accc28252bae7af327509a44ef78b603c1a27c1b153eb208404ac0637a3ea569",
  "webview/assets/local-conversation-thread-turn-entries-5bba2186bc7d.js": "17f2fe3cb2ba86685a8446ffe5a58d4a3703532496eb83dcbc440ec7e32983a8",
  "webview/assets/plugins-page-section-1f9dd2d984ea.js": "0799fc996db0a9ea20642f09082851a02a8b18701f3fc637b9342f4a4a271942",
  "webview/assets/profile-c8800e4c561a.js": "529409e1bfd862c6afc4311a13aa185a3ccffdbb867033f1ee4c858e76a652f2",
  "webview/assets/profile-lock-2c97a8dd8606.js": "0f75acb07aaa1c0d4ef2652fd4c7619e8f025c1536efb60b5ccb20798336843c",
  "webview/assets/profile-page-5c59c9aaf794.js": "22d2ac1f5c608e0327cdd96613432c2d3767aa77f9ce608862f9cc37814d0668",
  "webview/assets/profile-settings-3687227a4513.js": "698252a206deab0000525e45690475bdc68285668d668cfb2d4cc481de328612",
  "webview/assets/profile-settings-b8a00212b44b.js": "7c4515c0614968b9bac90cd6c4b1364d1617f8614ab16a8ab6c478910cf79a41",
  "webview/assets/profile-state-a44a7592f7bc.js": "63471c9cb8e625758a25d3c1723c91c0061785d1a34a641a14c91a5a4425befe",
  "webview/assets/profile-state-dbf66f9b8ba1.js": "755e3ea5a8ccdb4c2ae374a76f04158c5da9a38d2f46b8ddf65a2588c6624947"
};

/** Reviewed 20398 renderer and native carrier inventory. */
export const ACCOUNTS_NATIVE_20398_ASSETS = [
  "webview/assets/app-shared-8340f229c2b3.js",
  "webview/assets/app-initial-1ab6fbe93c4f.js",
  "webview/assets/profile-dropdown-items-4aea5fc452e5.js",
  "webview/assets/profile-574c8e173ddb.js",
  "webview/assets/apps-availability-4dd7d5bfa565.js",
  "webview/assets/plugins-settings-3b95c4b7016c.js",
  "webview/assets/mcp-settings-8e19d0fa2ece.js",
  "webview/assets/local-conversation-thread-269c4ee9ddf0.js",
  "webview/assets/page-b47428cf8a32.js",
  ".vite/build/main-CwxgTOle.js",
  ".vite/build/src-DCNiwad_.js"
] as const;
export const ACCOUNTS_NATIVE_20398_COMPANIONS: Readonly<Record<string,string>> = {
  ".vite/build/application-network-startup-YSC7OAs0.js": "52f0be375fb08281e88ad41be64220fb73f85210523e53e7d7acf094fda6344e",
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
  ".vite/build/src-CP7XXlpZ.js": "79623d50989f9efbcb8e5752c56b3cc608a0f5993c05112e03e11b718ac7a586",
  "webview/assets/app-primary-2a670e99a60c.js": "c002f1b37cb1a48dfab17b89aae2d3f20521b443d65ed64b6c5c1629c6ca528f",
  "webview/assets/local-conversation-thread-520e21c1c3ea.js": "21fc49b894fb3181af8c0be2f0a5d0161adad08467f8bc3168ad7eac51aa0a69",
  "webview/assets/local-conversation-thread-turn-entries-c50eba59fe06.js": "4d48730db9054538c6fc2b668946b832c524d2acea906b857a0197878b255834",
  "webview/assets/page-11dfd89b115a.js": "a55003d842cc4c4488df51d7bc56fb309460b856a2e3b0ee00fc9e918d54de97",
  "webview/assets/page-136742c5f36c.js": "9fca77eec6c26d8c051b003abf27229229589564903f6a8bbb0818d72014890b",
  "webview/assets/page-1731080c9e35.js": "4f190a5c3e0fc07bf212555c7af1e77341eaf6a6321b5c3c83e183241a06cb35",
  "webview/assets/page-190ef2fbd8b5.js": "08c35430976b11af51c8d87555a3c3a682fcbcf8bfa124f67fcb48efc1a7b3b6",
  "webview/assets/page-198cc4b83cd9.js": "79212ac9de3e7f7f76bae7ae61ab4a0fb36272456118283d5f73e9f3d5f7ae76",
  "webview/assets/page-1d37479c4104.js": "163aedae21ed259eb048adfdf3a2d77e268a4f71b74c4bf5351c18d310e155ed",
  "webview/assets/page-1da1183546ea.js": "c9ae51f8e9a0347ad67112d75632f4eb49b46465e12d386aa39dace27e06e214",
  "webview/assets/page-27b2ca3cef0d.js": "eaada54c05804d3cf6e9a41d3e794ab39bbe7193864693194144ffd7f314a880",
  "webview/assets/page-2876864f9fe2.js": "236aa4e991a5a15b768c6c296d6ff73f3e6cf42c7a628fa003e575bbb77d48af",
  "webview/assets/page-3178bd9f66c2.js": "085c19da706ff39956fc044977e9f15f3f604ed5b7fe0b20e50ce893edf9b1f6",
  "webview/assets/page-33354f4df962.js": "9f3706d3fe0cf353eb44145f06069124c5d47dbddc0a64d2c29ace0064b05566",
  "webview/assets/page-38154a7dc89c.js": "2d7a4d99a93c8131fb69167d9ce39d8a83366c949b3bc7e8d12422a91579289a",
  "webview/assets/page-424e7e765891.js": "51576678bea82d403eb666a02a27d5f32c788c202fdbaf598ee4369f60d35b14",
  "webview/assets/page-42e8a8aa163d.js": "23b97620dae280cdf07a143b2fbfe6e7428266999522af42ff1d71df0929a4b1",
  "webview/assets/page-470bdc6017df.js": "895e7ced88374b949f5a6e06d04ddb027d32d6c104bdab74a271c84d229f4b41",
  "webview/assets/page-5886f1bd6812.js": "94357bfd288f902e02e24bc508250c19c1a4f1c669fff4f95f94b16552d07e12",
  "webview/assets/page-6148b42d3b12.js": "73793a43e30af1852b30e755920bf6aa7c5d5db1369f1cfd9635b1927c9cf4e7",
  "webview/assets/page-6d6abf124686.js": "e04e12fb1c305903a02440dcb6809a4365da2c7c9a3d9e354e4919bfb7486290",
  "webview/assets/page-765b0ce22ae3.js": "f5dcbd292e913cee06357faa089a324535f427bfcdf4b268877d6d4dfc262d40",
  "webview/assets/page-768efb4314ca.js": "94b3212dfc6646af28b4cb841744db4a3575a9ad9cee3aa51a5be523d11f4c1a",
  "webview/assets/page-7aea79215255.js": "b76f4c78f60bd430502bbdad44d42f7031124ef7d3773c65dadb69a2802992f9",
  "webview/assets/page-7da747fd3107.js": "abe1f2b125919dbb7b5005360f52cb259dce92a11b110ccf0c7de8bab16d3b6e",
  "webview/assets/page-7e3ed9abf9c9.js": "723129b8870373d6c10e54d693ae3af4e5a4375730f505ea34db4054a180cd98",
  "webview/assets/page-8c901318c2f4.js": "d7a132a83d00e5fb3eb9810978a1f7f581da862ee03b1550fc6585d3c3318c14",
  "webview/assets/page-8d546590ea83.js": "a2d3611dd335dd658567765ede35f47b055029607361baf9e85890dc16ad9ca4",
  "webview/assets/page-8f8bccd266ae.js": "2f148f3539b7b1f698fe967a486a834b35041d03ca672c2c2c3e74b6b49dfcf1",
  "webview/assets/page-92c5888cd1f3.js": "8f6ee49e1e69509d035eca66609ff1e690b999317c3c36279a363fbeb2c79069",
  "webview/assets/page-a511a2537950.js": "7b5a42cdb55af232b3ab1059dd4f30178b0501f09e8fc54d4d2ad5c8a5c282b4",
  "webview/assets/page-ac1dc8f92a35.js": "dd49bfd5ccd54add0cd9ee7c07ce86b12d967727fc0eec48d5c424502fff01b6",
  "webview/assets/page-activity-panel-d4be9df04693.js": "1ce6f58e3450003128a2282c3e75ce83ccb9186ff9e9e0590250dad7b5c22ab2",
  "webview/assets/page-ade102ae48bc.js": "51379e93aa2ec6f453b989884625817ba838cf3974d36785a9bba717ea3477eb",
  "webview/assets/page-aea6a81709e3.js": "7521d781625ba2776789a798802295e269b9273102c0163d2d596201d4351ab6",
  "webview/assets/page-af998c422c20.js": "2c38e0c285d0907d6f6a11902a6dc3eedb911f7e2459bfb7b92980bef07288f0",
  "webview/assets/page-ancestry-completion-ba458f1daa48.js": "2b1e2815d7ad83bec10b5feb1eb3a927ac938f02fb6007869798b6f79309be7d",
  "webview/assets/page-b92c5b0a4044.js": "15a27c3b5469c2e4168050a335229916201bad7f374562353dd527363cd40896",
  "webview/assets/page-bcac083a8f32.js": "2e37c01c55be936aee5e24e1fd71b5e6538f71533566d84a1be0d9234f359ef0",
  "webview/assets/page-bootstrap-display.worker-a251533f04e5.js": "7ed2f925cc86e40042b8e15e7c3ee6ed450a6fdc381f53752910d648f00df69d",
  "webview/assets/page-ca58f83e5035.js": "5be26b03dc8106cd9da2dcf7e3ed91a93c33efaff9489d46571c60f45182939d",
  "webview/assets/page-capabilities-de1e176ec799.js": "f7644db1c1b773a7d548872b5682968da2ec6fea1090122244c198ba779b9416",
  "webview/assets/page-cf2f12bc5aab.js": "b321cd120cc0b91d29e93b7d4fb2196d40116e3d314862bc4d1e28d55db57d31",
  "webview/assets/page-codex-quick-chat-composer-ee316df26deb.js": "64ae28d4488f7893bd44421fc0f97255e0a748b32e0c2f711d75dc2584088431",
  "webview/assets/page-codex-quick-chat-window-eae3754826f5.js": "67f1462fd4166b04a41c61d2a1508df90dc9cce49200fa3019b591d7f219b45a",
  "webview/assets/page-collaborator-colors-fbfab70bc237.js": "34f1ebbd7560237a5905e3ef3dc98e4bd9690a69554f3d135e466b4e2cf62718",
  "webview/assets/page-collaborator-label-4b0bb64c48c3.js": "864e01e50215dd2043444e48468e8b1ee28215e0451790a68d25acebbe9505d5",
  "webview/assets/page-content-item-597633e23dff.js": "b947a1657a6b7162cb0c58a59696a8ffc2648260b17179d94005b93cbf640cb1",
  "webview/assets/page-d18124fcf5eb.js": "a2e68537fa3c1942b99a2edc9613b106a20f554bb33a1ac41a5aa2020dd5bb18",
  "webview/assets/page-da69185b3663.js": "fc2eb830eba3421e3218ff9287aa212d0772fa212a92cd9a44829778e9b05c2b",
  "webview/assets/page-data-57c38dedcd45.js": "1faca14ba74a02f45bba844d15d921b5cf01cea6535fcafdfc40e11fc43e4fee",
  "webview/assets/page-dd77ce24508b.js": "18bd3ead99639af03e0edcd9ce47edc9a0de259b4de8a03d6f0c52015267ee53",
  "webview/assets/page-ea1a9665b11b.js": "11838339eed96377d3a1e309fcd23c9badc2ec69c38f4aa97c95a542b7ead7a6",
  "webview/assets/page-f01eac324d59.js": "75d0338032f95f7d493905883cc4889bef3afac12ce00bf738863eb8b336076c",
  "webview/assets/page-f4efe92a2585.js": "b01546be11fac0591cd3712b001ef76ce0eb73fb778ba422bb94591cf54e519a",
  "webview/assets/page-header-button-4908d2546cfa.js": "4f5713d4474eb1bc5f0a5acce0f8000a6b73fb52eb4da9fe7123b75d1954a702",
  "webview/assets/page-impression-f7a92884f4c9.js": "99cc892181eb2eee5238e165e44bf041acb09f73d530a89b0d70a36aec51258a",
  "webview/assets/page-layout-1c7928fc98f9.js": "d2bf6985d347d5ea8538029368f438771dc4c4eb0acf55125c6c67bf320b32f8",
  "webview/assets/page-layout-ae89a13c0d93.js": "20dcbecb4cf3cf3c933b011d2f934793c85e3583644eee79f9657e403e2c6f01",
  "webview/assets/page-menu-document-95f764ecd11a.js": "3bed428741bb4c90074b64f8b98993270510faf0b3d48285cb4a7a68f46e052f",
  "webview/assets/page-menu-document-e8beb55862d3.js": "56f12cf43005ca7cda36fc05f5b3326b8f3ed76e530206b4e3882375974949b6",
  "webview/assets/page-metadata-75fdcf49c256.js": "4f5954bdfaa2315d91a0dc72cd608340f240ab86db9350333fbb412b6596a2f6",
  "webview/assets/page-rename-dialog-56f0dfa13187.js": "9eeb30a7c579e9842fcfc76fdbb896b04fa2806535003dce572a146d7163066f",
  "webview/assets/page-rename-dialog-f879f58818c7.js": "efc2be095879d3e6b9b529b00abf9c3890c9b5137994839ecbaf1c03a639427d",
  "webview/assets/page-sharing-5b71c6726df5.js": "4b1cc44a664fe1ae26483f25ad2b24700792dc2fad69a9c074391d9c745078f4",
  "webview/assets/page-sharing-fe577c0d1a54.js": "6c958d6554775df7f439f32dc461f80dec74c6c1addbad8da3e5b4d2d92eedec",
  "webview/assets/plugins-settings-dbb682d6b9b2.js": "d79c6f6c60c85e3cefe4a316dcd5e151940031f146d4b3a84f302b4a9c30a2db",
  "webview/assets/plugins-settings-row-ed204615c726.js": "07e94a6c932f5c577c32f53acfd07e4bbcb77e71704abe1ec4fabc90e71bdda9",
  "webview/assets/profile-58ad1aba4d33.js": "91cfe6eaab5a9412b77ae13352cfa768a7730d3e7fa01a82dfb79abd2df1f5ca",
  "webview/assets/profile-avatar-98f2688f140c.js": "96a8813105c82b9d360f552631f36e44b1b4419044b84d1ce7aa3a9fe3fb9f61",
  "webview/assets/profile-entrypoint-468cc3e89e85.js": "483cbda23f4cc52498c56cf0b96bee853cdfd25a497c423c03eb5c0514df1fb8",
  "webview/assets/profile-lock-62bdafac5b05.js": "767d6658270b55b0ebaaa0a0b2a3d6f11b306ac86a72216d809d4958c4ff64df",
  "webview/assets/profile-page-92966366026a.js": "1ec5c6eac7db31f69321f672ffa067d4f16e74c55db8fc14ce18dfd82d4448e7",
  "webview/assets/profile-settings-4103fed8dc14.js": "824a6ae38bf683ebf20a7ec0dae97dd0c63b4743def88e20adbfc63cf3b1bf07",
  "webview/assets/profile-settings-80ad626bb04b.js": "5401e3b869a5ce194fab2ce53023ffb3821a4ddc56f3133233079e087109c390",
  "webview/assets/profile-state-26b733bf2940.js": "1412afa47f93c7ba3dfcfe0188cbde85f17a5357a7e7dbcc5130cf6014c5c4ff",
  "webview/assets/profile-state-9819f3c77055.js": "b7eb053de56c95226df6ddcc2682de41b8d211b2361818c4ade55361f6ec526c"
};

/** Reviewed 20156 renderer and native carrier inventory. */
export const ACCOUNTS_NATIVE_20156_ASSETS = [
  "webview/assets/app-shared-8bd9d0399038.js",
  "webview/assets/app-initial-6350d04672d0.js",
  "webview/assets/profile-dropdown-items-d842ad78cd70.js",
  "webview/assets/profile-d4ec050a2b68.js",
  "webview/assets/apps-availability-602b68c7254e.js",
  "webview/assets/plugins-settings-39f4509a79cc.js",
  "webview/assets/mcp-settings-83d0520492d3.js",
  "webview/assets/local-conversation-thread-c8c5e92ea89e.js",
  "webview/assets/page-400328cd46f4.js",
  ".vite/build/main-CqEoQDOU.js",
  ".vite/build/src-BJv5Mk7n.js"
] as const;
export const ACCOUNTS_NATIVE_20156_COMPANIONS: Readonly<Record<string, string>> = {
  "webview/assets/app-primary-6f60e9ac4103.js": "7fe9c00b03cb1de3ebc3a4bf298fc44b13a7fe67ca9cc335a9e2ecda969a1321",
  "webview/assets/local-conversation-thread-810738f6424a.js": "3403f109610021e6e5e3738d838ff0d3f076113ffc4d4724aff28cf096ade18f",
  "webview/assets/local-conversation-thread-turn-entries-289ca6f16609.js": "1a3b8fbb3442fa3fca5d6b545cfde2cb193bd314b31dad8e3feb70bbf498aec2",
  "webview/assets/page-0b1c6090510f.js": "200b19a73de315d67bb93e3c8fab2ec6f4eb8062fb7c0561e71c6d396cccaee5",
  "webview/assets/page-17fd692cd118.js": "6ccc715f527d1decd88f2511987ad31da9b51c9efdd52d8e5b774bc6efb3a83b",
  "webview/assets/page-1bebb704a6e2.js": "b0c391a26852ed81ee8229b01849fecb4a4af6136fc9d0e3d7372b6a7e14b3fc",
  "webview/assets/page-1f011175b29b.js": "7d00e36272618c21d63fc8b86ae5595d0369133bdcc339acfdd161e2af1140fd",
  "webview/assets/page-234c9b532d90.js": "2639056be7eed574adc0b26559cd93e3349613f41d0f596239dba06a5a34900f",
  "webview/assets/page-2548e957e30a.js": "4518fdc065c1fa80511d1919a618558e72412b3fd988db0916e5a4c137292b92",
  "webview/assets/page-26ffb5452812.js": "81a4b2e46c7ea5bc228120932ed8da4bef66ebb98d7a2fdd8e5c6ecd559d086a",
  "webview/assets/page-28834fc2705f.js": "03a323de77d5773de604034df99f59f63104535fe40db3b15f05efb55ae51b37",
  "webview/assets/page-2c23f2b4f0e0.js": "31b26c808784e98a1f1b153634079ec58e1a6645dca434579dac1f7b05a4af9c",
  "webview/assets/page-2cfafa4f8a9b.js": "2a277a06d9965ed3c44b635a392928b4f85846a2b9e624555b7b3789c4d87c8d",
  "webview/assets/page-38eaf79161b7.js": "7c19b8c7d133620551740211768eba4281efb681551258ffc1e54c5957d2b826",
  "webview/assets/page-423580df80ca.js": "8ed03f3010510d8cd7b9900feaf7c6ac1bb138a9909458b95c23a54e66bd21fa",
  "webview/assets/page-471a1ffbb7b4.js": "3be10aa8ad7b4ae2cf1ba697026caf73d9892efb971a701853880368bebf78f3",
  "webview/assets/page-6567865d967f.js": "7ee4b88b45a26cd8f7c1c2a5aacd5c4299260ecc6548c475c301984cd6e81711",
  "webview/assets/page-6b177e2d195b.js": "68152b474a3961def280bcd1478d4b25735f7135e9d5d497e3d6826ee4aeb76b",
  "webview/assets/page-6ea20d715004.js": "ac0662af5d6f8565a11701aafed741c2c14bc9709f8903fe7f79722a1de040d9",
  "webview/assets/page-76a11dcd35d4.js": "a6143bff0af0dad121f60bc40a7a8aa45f746f13477e75bfb95e71e35ad05fed",
  "webview/assets/page-77ca61decd4e.js": "fb6e5554eb93f780c83284a9da6263bed9e8081a97e1f09abd60f7aa08119562",
  "webview/assets/page-7c53d46c81b9.js": "3d7040b04d39d88d5f64fc4306b9380bd728ad32dab8c797f14b45f2f6a127de",
  "webview/assets/page-7eaa6a5a9846.js": "2b7f105984145fbdcded41b290cff9ffbab27793bdd86b3b987a24cea0a4d33c",
  "webview/assets/page-80b0eaeae2de.js": "f4e6c8ad9aad18636df7066d577be278c2034a36d6b428fe0a2ce9daa00cd5de",
  "webview/assets/page-81bbc8bec72a.js": "71c272f63e539a1f86f316ec506c6395142408af8eaf52ff3345e327afcc4cb8",
  "webview/assets/page-8e2539e85410.js": "f11f29a9ac807930811cb292cae4e205f81e13b53359618c795fc4b06bc5b698",
  "webview/assets/page-9a799119b11b.js": "f0fa0b54fd3f5a663d945a9a6cc0bcdd36ba618efe179161487cbf5f96a6eaa1",
  "webview/assets/page-a1448db23afa.js": "50390b012eae98bc004580c4d96e0b6f1e9c1569e5cd276ca804ebda47274abd",
  "webview/assets/page-a9ebc68f154d.js": "b85c0d6c88296635688641a6cfac2e5950375df6825bda8e4c9b831c7df8c01d",
  "webview/assets/page-activity-panel-6c1d4e9c7bb3.js": "259f2f99dcb52862849a9d1c6d0444cd14cf07a02f580500fd9d04b10c92fe8d",
  "webview/assets/page-aff815fab918.js": "d546847afe9c1070c8630f83a39b2f88a2bfb6eafecd8f0c111fd3b69cb3a54a",
  "webview/assets/page-ancestry-completion-864acdc687ab.js": "d1ded6fc285b340fd9fd28691e9cd68e96a0096dd7e6731c667ad51f09dfef2f",
  "webview/assets/page-bc494017d4b4.js": "f7c02a251fa128d412f32b1266c62527829fdcf68b27e6ecb8d19861418fd978",
  "webview/assets/page-bc6491f2ed4c.js": "c85ed20ea01593d678ea378f89dee8326d33f57ad48afc3902bbc9ebdd4db15d",
  "webview/assets/page-bootstrap-display.worker-a251533f04e5.js": "7ed2f925cc86e40042b8e15e7c3ee6ed450a6fdc381f53752910d648f00df69d",
  "webview/assets/page-c0dc350ba726.js": "28a6a7547d74f321ebde8856316d596cbae0df1640bf6f14da14b6115b2c22f1",
  "webview/assets/page-c37c62172876.js": "1f8e765c4468de102ae851262406882bccc5b396a4db6b247e071599653ffe59",
  "webview/assets/page-c9473101ffa3.js": "59f2e613ef2b83ea67c9d2d6b378e9105d86225d720c153fac28be84c9c46d99",
  "webview/assets/page-capabilities-a020e071cf7f.js": "c5c6fb72fc2b9adc0c36218be0a27bf2ffc5f216512dc802d06814c50b1ea0ad",
  "webview/assets/page-codex-quick-chat-composer-a1291466a027.js": "33424dbfdc85ae40985a2619893998ac564a82c371b8af63c5e22e1b8dc75912",
  "webview/assets/page-codex-quick-chat-window-58edc97dc0c4.js": "3ccb11f7c4c0fefd2d3d2fe9370b1a83bb18f38661c90e73e1d2fcf6682f7ca1",
  "webview/assets/page-collaborator-colors-d7417213568d.js": "943c0536f84dd9513d1665b844e46de977d4c883d317e09359659236c8d66264",
  "webview/assets/page-collaborator-label-63f6f4c36946.js": "e4a37e8862aaa274370176918fc9c9ec9678311d4d1182f74145de0f350f3843",
  "webview/assets/page-content-item-8fa66ea0e0a4.js": "61b983b70b9dd75e1611878b1c009966b95549c135b2f9049870441ef5dfe5a4",
  "webview/assets/page-d5a3096fd3c6.js": "bfa34fa75c120ba9fc259460d57f1fb01ffdfde6d5a2038b38ca7f1f06cc063e",
  "webview/assets/page-d8207ef53a0c.js": "d54f88ac184957a3e73c77ce760f45af106df9f16402757e5f1b51902f58a885",
  "webview/assets/page-data-25820208f52f.js": "03599b5ee93a58a99c2144de977ec87d4b588f0d99f728a427f7762e1fffc436",
  "webview/assets/page-e09275362e85.js": "ef5b238e9ac632a861e4c3fa129e2d6b2136272e347c9c0a945288ca8a74c670",
  "webview/assets/page-e3311e22f58a.js": "a0a97e26b339568aef0dde832cfe1ac1403841352138981309addda143c9bc38",
  "webview/assets/page-e68c20a20278.js": "3d269c83eff6eb0e596f9887f3c2a304a3a1f7bc02bca186542d719f4606cab1",
  "webview/assets/page-ec80252360d0.js": "db9a654f3f7fba0fd71144660ba96832f6508722cc5a94a32438a628db01b3a2",
  "webview/assets/page-edac42e7f45a.js": "b51eec848b27dd2e177bfe36c4282f70ddea3cd4d305c085102a6b0e70506dfa",
  "webview/assets/page-fc6a449ad1b2.js": "6bccb3e3221ddbb87ef2cff71dced7814a616ace33759bcec5531be3f50b78b9",
  "webview/assets/page-fcc40b4325e2.js": "54714327204a1cc82a9057971a646d5dc8255a32792b414dd33575faa43a1223",
  "webview/assets/page-fdfb4cc0bb92.js": "4dc54c1a46d966f8f63160dc97f61d3291c955c1ac6e4205dca2da58ec6b92a0",
  "webview/assets/page-header-button-19b610225945.js": "c6b1f26f094697f68ede9c28ddf6ab2a520bb743aefe7add4d18ede4b320a536",
  "webview/assets/page-impression-757c7d5c8c91.js": "3d49efe3369a779e250813e3955e01d51931e7bc41c0879ca501f6b7c7ab37f7",
  "webview/assets/page-layout-3aa87dd72b01.js": "da402d10d5bc6b8b84d2dfc2126fc701affc20ba6bf5dda4b1ae8138d1f6521d",
  "webview/assets/page-layout-50d228b76141.js": "423aeb9d5f3fdca514ec5a2dfcf3ff3f4bbbff4daa74ccf62313a1c7e00348c8",
  "webview/assets/page-menu-document-457335211552.js": "ce76a76d95cd9994c8dccd3e604c69132cc5207ee6ed9a1e8677cef90b7ef3e6",
  "webview/assets/page-menu-document-72758c32036f.js": "77ce814e9ebe6a68626689d765d076f7e5fa6a81b12126ef43358fb7be650299",
  "webview/assets/page-metadata-5f461f56ef83.js": "a3f91ec9ff5dfd669502565c4e957daa0cfb12742c300d492c19836b9cd2a0b3",
  "webview/assets/page-rename-dialog-6e83bc869dcc.js": "1a93ed535d81ece04ba67f2b32052fbf7f35140ed0700002cc6640bdc25c438e",
  "webview/assets/page-rename-dialog-c36993d9279c.js": "08bff92bdd91838cb3f265508c64c94c85809620f7072557d0a625c5bf0eb4ed",
  "webview/assets/page-sharing-8cf15cac3826.js": "738ea859ed578721aa4d0e07b536dd2c6575a798c40e127c3878eacac668486e",
  "webview/assets/page-sharing-d16f064ddce7.js": "7dbd3fba9ea2259565382a28ab9a0fa2f16d45fed1e954a26c2e6dfc83532d36",
  "webview/assets/plugins-settings-577ebe3677a7.js": "fb507143d103e029b130a6111ba315c1654dda8757c5dbcda197bde28a167641",
  "webview/assets/plugins-settings-row-c4c97128cef3.js": "6ba741060442c30078d0f2c4a74adbc695b3d80bfc303bc1a4a27cecc524e1f3",
  "webview/assets/profile-avatar-6a8d67ddceb9.js": "41bcf444ba08505b8c235c5a9420745e5002de37487b6bfcc09901c745f03493",
  "webview/assets/profile-b460d3d27ce6.js": "a4ee21dbf3ac263c1c3d317ca9151bed958e7447708bcd28334e7a10826d30c8",
  "webview/assets/profile-entrypoint-a54cc85bf2ef.js": "415e3d43f9826951c1eacffeff175c29615790b3a7449b3b350611422c6a41f3",
  "webview/assets/profile-lock-a028da467bea.js": "97b447daaed29bbb16ef23a9e248885c891ee4c5679448afc975a0a261dfe19d",
  "webview/assets/profile-page-83fb8642f64f.js": "45faea96cb6148489ee7482d70a5a5336bc19615b018fdb7919bbc31d6f24ee8",
  "webview/assets/profile-settings-6d54d51340da.js": "2a38fdc966b8e6cc25dbb43e7f0d8f1ceb247295b0b7e1034cbce5027c463909",
  "webview/assets/profile-settings-e5cfaa06c30e.js": "b9b84f63cfe4e5b0c7af290bc4c961acc2e2d4cf4b2384302bfbdf5ba4ff2f58",
  "webview/assets/profile-state-75ef6a028e05.js": "ad03286ca99616666cd4bfef080b5e5283270b7cca90a6d140f49d4f1e74769f",
  "webview/assets/profile-state-93cd0cd55b44.js": "476752921fbb3ffd43590e3f97c6befa3297c3ea3b3dc30d44796060a66cd92f",
  ".vite/build/src-BSoROW9v.js": "02bfe16d532e9de068979823a2409783b03a10d9b9348e8ad6247ba81aca1e16",
  ".vite/build/src-C9YLnbgY.js": "56f4e7f71fb8e93a022d0378322e8fa723a8da07085138957e722e0ac36e9c9d",
  ".vite/build/src-CP7XXlpZ.js": "79623d50989f9efbcb8e5752c56b3cc608a0f5993c05112e03e11b718ac7a586",
  ".vite/build/application-network-startup-CfAQmSYg.js": "cd6e8a8fbc4354a6e6ff19c6e4bf6fc1fb3960c63708c83871357c6238f516a8"
};

const SHARED_QUERY_COMPANIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "26.917.51856": ACCOUNTS_NATIVE_10492_COMPANIONS,
  "26.917.61114": ACCOUNTS_NATIVE_10640_COMPANIONS,
  "26.917.71314": ACCOUNTS_NATIVE_10954_COMPANIONS,
};

export interface AccountsNativeCompatibilityRecordV1 {
  version: 1;
  bridgeVersion: 1;
  status: "compatible" | "unavailable";
  build: string;
  hooks: string[];
  hookSetSha256: string;
  assets: Array<{ path: string; sha256: string }>;
  reason?: string;
}

export interface AccountsNativeCompatibilityStatusV1 {
  compatible: boolean;
  reason: string | null;
  hookSetSha256: string | null;
  build: string | null;
}

/**
 * Recheck the actual payload at preparation, startup and enable time. Callers
 * supply their own contained reader so this contract works in both Node and
 * Electron's ASAR filesystem without copying a second verifier.
 */
const EXACT_ASSET_INVENTORIES: Readonly<Record<string,readonly string[]>> = {"26.1007.30912":ACCOUNTS_NATIVE_20156_ASSETS,"26.1007.71326":ACCOUNTS_NATIVE_20398_ASSETS};
const EXACT_COMPANION_INVENTORIES: Readonly<Record<string,Readonly<Record<string,string>>>> = {"26.1007.30912":ACCOUNTS_NATIVE_20156_COMPANIONS,"26.1007.71326":ACCOUNTS_NATIVE_20398_COMPANIONS};

export function validateAccountsNativeCompatibility(
  value: unknown,
  readAsset: (path: string) => string,
  hash: (source: string) => string,
): AccountsNativeCompatibilityStatusV1 {
  const unavailable = (reason: string): AccountsNativeCompatibilityStatusV1 => ({
    compatible: false, reason, hookSetSha256: null, build: null,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable("Accounts requires a compatible desktop refresh.");
  const record = value as Partial<AccountsNativeCompatibilityRecordV1>;
  if (record.version !== 1 || record.bridgeVersion !== 1 || record.status !== "compatible") {
    return unavailable("This desktop build does not provide the required Accounts integration.");
  }
  if (typeof record.build !== "string" || !/^[0-9][0-9.]{1,63}$/.test(record.build)
    || !Array.isArray(record.hooks) || record.hooks.length !== ACCOUNTS_NATIVE_REQUIRED_HOOKS.length
    || [...record.hooks].sort().join("\0") !== [...ACCOUNTS_NATIVE_REQUIRED_HOOKS].sort().join("\0")
    || typeof record.hookSetSha256 !== "string" || record.hookSetSha256 !== hash(JSON.stringify(record.hooks))
    || !Array.isArray(record.assets) || record.assets.length !== (EXACT_ASSET_INVENTORIES[record.build] ? EXACT_ASSET_INVENTORIES[record.build]!.length : SHARED_QUERY_COMPANIONS[record.build] ? 10 : record.build === "26.915.31945" ? 9 : 8)) {
    return unavailable("The Accounts compatibility record is incomplete.");
  }
  const paths = new Set<string>();
  for (const asset of record.assets) {
    if (!asset || typeof asset.path !== "string" || !/^(?:webview\/assets\/[A-Za-z0-9._-]+|\.vite\/build\/(?:main|src)-[A-Za-z0-9_-]+)\.js$/.test(asset.path)
      || paths.has(asset.path) || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      return unavailable("The Accounts compatibility record contains an invalid asset.");
    }
    paths.add(asset.path);
    try {
      if (hash(readAsset(asset.path)) !== asset.sha256) return unavailable("Desktop files changed after Accounts was prepared. Refresh Tweakers to restore Accounts.");
    } catch {
      return unavailable("A required Accounts desktop file is unavailable.");
    }
  }
  if (EXACT_ASSET_INVENTORIES[record.build] && (EXACT_ASSET_INVENTORIES[record.build]!.some(path => !paths.has(path)) || paths.size !== EXACT_ASSET_INVENTORIES[record.build]!.length)) return unavailable("The reviewed Accounts carrier inventory changed.");
  const expectedFamilies = ["app-initial", "app-primary", "profile", "plugins-page", "mcp-settings", "local-conversation-thread"];
  if (record.build === "26.915.31945" || SHARED_QUERY_COMPANIONS[record.build]) expectedFamilies.push("apps-availability");
  if (SHARED_QUERY_COMPANIONS[record.build]) expectedFamilies.push("app-shared");
  if (!EXACT_ASSET_INVENTORIES[record.build] && expectedFamilies.some((family) => record.assets!.filter((asset) =>
    new RegExp(`^webview/assets/${family}-[a-f0-9]+\\.js$`).test(asset.path)).length !== 1)) {
    return unavailable("A required Accounts component is missing from its compatibility record.");
  }
  if (["main", "src"].some((family) => record.assets!.filter((asset) => new RegExp(`^\\.vite/build/${family}-[A-Za-z0-9_-]+\\.js$`).test(asset.path)).length !== 1)) {
    return unavailable("A required native Accounts browser helper is missing.");
  }
  // These official 9922 companions are unmodified and therefore not receipt
  // assets, but must remain authenticated when startup rechecks the payload.
  if (EXACT_COMPANION_INVENTORIES[record.build] || record.build === "26.915.31945" || SHARED_QUERY_COMPANIONS[record.build]) {
    for (const [path, expected] of Object.entries(EXACT_COMPANION_INVENTORIES[record.build] ?? SHARED_QUERY_COMPANIONS[record.build] ?? ACCOUNTS_NATIVE_9922_COMPANIONS)) {
      try {
        if (hash(readAsset(path)) !== expected) return unavailable("An Accounts companion changed after preparation. Refresh Tweakers to restore Accounts.");
      } catch { return unavailable("A required Accounts companion is unavailable."); }
    }
  }
  return { compatible: true, reason: null, hookSetSha256: record.hookSetSha256, build: record.build };
}
