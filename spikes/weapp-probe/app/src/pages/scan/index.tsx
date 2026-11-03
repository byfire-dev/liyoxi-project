import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api, errorCode, report, ProbeError } from "../../lib/api";
import { Frame } from "../../lib/frame";
type Ticket = { ticketId: string; candidates: string[]; expiresAt: string };
export default function ScanPage() {
  const [shortCode, setCode] = useState("");
  const [ticket, setTicket] = useState<Ticket>();
  const [message, setMessage] = useState("电脑打开验证服务 /desktop，点击下方开始。");
  const [started, setStarted] = useState(0);
  const [scenario, setScenario] = useState("scan_normal");
  const [busy, setBusy] = useState(false);
  const recordFailure = async (error: unknown, start: number, route: string) => {
    const code = errorCode(error);
    setMessage(code);
    await report({
      item: "V8",
      scenario: route,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      result: code === "CANCELLED" ? "cancelled" : "failure",
      errorCode: code,
    });
  };
  const lookup = async (manual: boolean) => {
    if (busy) return;
    const start = Date.now();
    setStarted(start);
    setTicket(undefined);
    setBusy(true);
    const route = manual ? "manual_code" : scenario;
    try {
      let query: string;
      if (manual) {
        if (!/^[A-Za-z0-9]{8}$/.test(shortCode)) throw new ProbeError("SHORT_CODE_INVALID");
        query = `shortCode=${encodeURIComponent(shortCode)}`;
      } else {
        const value = await Taro.scanCode({ onlyFromCamera: true, scanType: ["qrCode"] });
        const match = /^https:\/\/[^/?#]+\/a\?t=([A-Za-z0-9_-]{22})$/.exec(value.result);
        if (!match) throw new ProbeError("QR_FORMAT_INVALID");
        query = `token=${encodeURIComponent(match[1])}`;
      }
      setScenario(route);
      setTicket(await api<Ticket>(`/scan/lookup?${query}`));
      setMessage("点选与电脑屏幕相同的两位数字");
    } catch (error) {
      await recordFailure(error, start, route);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (digit: string) => {
    if (!ticket || busy) return;
    setBusy(true);
    try {
      await api("/scan/confirm", "POST", { ticketId: ticket.ticketId, digit });
      await report({
        item: "V8",
        scenario,
        sizeBytes: 0,
        durationMs: Date.now() - started,
        result: "success",
        errorCode: "",
      });
      setTicket(undefined);
      setMessage("已确认，请核对电脑已在 2 秒轮询内显示成功；电脑端另记录完整耗时。");
    } catch (error) {
      await recordFailure(error, started, scenario);
      setTicket(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="V8 普通二维码配对" locked={busy || !!ticket}>
      <Text className="line">亮度场景：{scenario}</Text>
      <View className="nav">
        {["scan_normal", "scan_dim", "scan_bright"].map((value) => (
          <Button
            key={value}
            size="mini"
            disabled={busy || !!ticket}
            onClick={() => setScenario(value)}
          >
            {value}
          </Button>
        ))}
      </View>
      <Button disabled={busy || !!ticket} onClick={() => void lookup(false)}>
        扫描电脑普通二维码
      </Button>
      <Input
        value={shortCode}
        maxlength={9}
        placeholder="8 位短码（可带连字符）"
        onInput={(event) => setCode(event.detail.value.trim().replace(/-/g, "").toUpperCase())}
      />
      <Button disabled={busy || !!ticket} onClick={() => void lookup(true)}>
        使用短码
      </Button>
      {ticket && (
        <View className="panel">
          <Text>票据到期：{ticket.expiresAt}</Text>
          {ticket.candidates.map((digit) => (
            <Button key={digit} disabled={busy} onClick={() => void confirm(digit)}>
              {digit}
            </Button>
          ))}
          <Button
            disabled={busy}
            onClick={() => {
              void recordFailure(new ProbeError("CANCELLED"), started, scenario);
              setTicket(undefined);
            }}
          >
            取消本次配对
          </Button>
        </View>
      )}
      <Text className="line">{message}</Text>
    </Frame>
  );
}
