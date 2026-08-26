-- ========== migration 0002：device 运行时事实列（#37；03 §6.2 node.hello） ==========
-- P1-04 建表时 Device WS 尚未实现，漏掉 node.hello 携带的两项运行时事实，
-- P1-10 只能把 run.dsh_distribution_version 改由 CreateRunInput 传入（注入点悬空）。
-- 配对建行时两者均未知：dsh_distribution_version 可空待 hello 回填；
-- plugin_pack_digests 以空数组起算（「尚未上报」≡ 没有任何 pack）。

alter table device
  add column dsh_distribution_version varchar(64),
  add column plugin_pack_digests jsonb not null default '[]'::jsonb;

alter table device
  add constraint device_plugin_pack_digests_array
  check (jsonb_typeof(plugin_pack_digests) = 'array');
