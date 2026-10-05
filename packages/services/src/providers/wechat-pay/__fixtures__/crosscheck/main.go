// 跨实现核对：用微信支付官方 Go SDK（github.com/wechatpay-apiv3/wechatpay-go，版本钉在 go.mod、校验值在 go.sum）
// 对同一批输入做签名、验签、解密与通知解析，把结果写成 JSON，由 cross-check.generate.ts 与本实现逐项比对。
// 只在一次性容器里运行（pnpm wxpay:vectors），不进工作区的依赖、不进锁文件、不进 CI。
// 输入里的私钥是脚本现场生成的临时密钥，只在容器的临时目录里出现；输出里没有任何私钥。
//
// 用法：go run . <输入.json> <输出.json>
package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"

	"github.com/wechatpay-apiv3/wechatpay-go/core/auth/signers"
	"github.com/wechatpay-apiv3/wechatpay-go/core/auth/verifiers"
	"github.com/wechatpay-apiv3/wechatpay-go/core/notify"
	"github.com/wechatpay-apiv3/wechatpay-go/utils"
)

const sdkPath = "github.com/wechatpay-apiv3/wechatpay-go"

// Party 一方的身份：序列号（或公钥 ID）与密钥对
type Party struct {
	Serial        string `json:"serial"`
	PrivateKeyPem string `json:"privateKeyPem"`
	PublicKeyPem  string `json:"publicKeyPem"`
}

// SignCase 一条签名核对：message 是本实现构造的签名串，ourSignature 是本实现用 by 那一方的私钥签出的
type SignCase struct {
	Name         string `json:"name"`
	By           string `json:"by"`
	Message      string `json:"message"`
	OurSignature string `json:"ourSignature"`
}

// SealCase 一条加密核对：容器里按 AEAD_AES_256_GCM 加密，官方 SDK 解回来，本实现再解一遍
type SealCase struct {
	Name           string `json:"name"`
	Plaintext      string `json:"plaintext"`
	AssociatedData string `json:"associatedData"`
	Nonce          string `json:"nonce"`
}

// Delivery 一次回调投递：请求头与原始请求体
type Delivery struct {
	Name    string            `json:"name"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type input struct {
	Merchant      Party      `json:"merchant"`
	WechatPay     Party      `json:"wechatPay"`
	APIV3Key      string     `json:"apiV3Key"`
	SignCases     []SignCase `json:"signCases"`
	SealCases     []SealCase `json:"sealCases"`
	Notifications []Delivery `json:"notifications"`
	// 让官方 SDK 以“微信支付”的身份给这些报文签名，本实现去验
	ToSign []Delivery `json:"toSign"`
}

type signResult struct {
	Name string `json:"name"`
	// 官方 SDK 用同一把私钥对同一个签名串签出的结果
	SDKSignature string `json:"sdkSignature"`
	// 官方 SDK 的验签器接受本实现的签名
	SDKVerifiesOurs bool `json:"sdkVerifiesOurs"`
	// 改掉签名串的一个字节之后，官方 SDK 的验签器拒绝
	SDKRejectsTampered bool `json:"sdkRejectsTampered"`
}

type sealResult struct {
	Name       string `json:"name"`
	Ciphertext string `json:"ciphertext"`
	// 官方 SDK（utils.DecryptAES256GCM）解出的明文
	SDKPlaintext string `json:"sdkPlaintext"`
}

type notifyResult struct {
	Name string `json:"name"`
	// 官方 SDK 的通知处理器（notify.Handler.ParseNotifyRequest）验签并解密成功
	SDKAccepted  bool   `json:"sdkAccepted"`
	SDKError     string `json:"sdkError,omitempty"`
	ID           string `json:"id,omitempty"`
	EventType    string `json:"eventType,omitempty"`
	SDKPlaintext string `json:"sdkPlaintext,omitempty"`
}

type output struct {
	SDK           string         `json:"sdk"`
	Go            string         `json:"go"`
	Sign          []signResult   `json:"sign"`
	Seal          []sealResult   `json:"seal"`
	Notifications []notifyResult `json:"notifications"`
	Signed        []Delivery     `json:"signed"`
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "crosscheck:", err)
		os.Exit(1)
	}
}

func sdkVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return sdkPath
	}
	for _, dep := range info.Deps {
		if dep.Path == sdkPath {
			return sdkPath + " " + dep.Version
		}
	}
	return sdkPath
}

func main() {
	if len(os.Args) != 3 {
		must(fmt.Errorf("用法：go run . <输入.json> <输出.json>"))
	}
	raw, err := os.ReadFile(os.Args[1])
	must(err)
	var in input
	must(json.Unmarshal(raw, &in))
	ctx := context.Background()
	out := output{SDK: sdkVersion(), Go: runtime.Version()}

	parties := map[string]Party{"merchant": in.Merchant, "wechatPay": in.WechatPay}
	for _, c := range in.SignCases {
		party, ok := parties[c.By]
		if !ok {
			must(fmt.Errorf("签名用例 %s：不认识的一方 %s", c.Name, c.By))
		}
		privateKey, err := utils.LoadPrivateKey(party.PrivateKeyPem)
		must(err)
		publicKey, err := utils.LoadPublicKey(party.PublicKeyPem)
		must(err)
		signer := &signers.SHA256WithRSASigner{MchID: "0", CertificateSerialNo: party.Serial, PrivateKey: privateKey}
		signed, err := signer.Sign(ctx, c.Message)
		must(err)
		verifier := verifiers.NewSHA256WithRSAPubkeyVerifier(party.Serial, *publicKey)
		out.Sign = append(out.Sign, signResult{
			Name:               c.Name,
			SDKSignature:       signed.Signature,
			SDKVerifiesOurs:    verifier.Verify(ctx, party.Serial, c.Message, c.OurSignature) == nil,
			SDKRejectsTampered: verifier.Verify(ctx, party.Serial, c.Message+" ", c.OurSignature) != nil,
		})
	}

	block, err := aes.NewCipher([]byte(in.APIV3Key))
	must(err)
	gcm, err := cipher.NewGCM(block)
	must(err)
	for _, c := range in.SealCases {
		sealed := gcm.Seal(nil, []byte(c.Nonce), []byte(c.Plaintext), []byte(c.AssociatedData))
		ciphertext := base64.StdEncoding.EncodeToString(sealed)
		plaintext, err := utils.DecryptAES256GCM(in.APIV3Key, c.AssociatedData, c.Nonce, ciphertext)
		must(err)
		out.Seal = append(out.Seal, sealResult{Name: c.Name, Ciphertext: ciphertext, SDKPlaintext: plaintext})
	}

	wechatPayPublicKey, err := utils.LoadPublicKey(in.WechatPay.PublicKeyPem)
	must(err)
	handler, err := notify.NewRSANotifyHandler(
		in.APIV3Key, verifiers.NewSHA256WithRSAPubkeyVerifier(in.WechatPay.Serial, *wechatPayPublicKey),
	)
	must(err)
	for _, n := range in.Notifications {
		request, err := http.NewRequest(http.MethodPost, "http://127.0.0.1/hooks", bytes.NewBufferString(n.Body))
		must(err)
		for name, value := range n.Headers {
			request.Header.Set(name, value)
		}
		content := map[string]interface{}{}
		parsed, err := handler.ParseNotifyRequest(ctx, request, &content)
		result := notifyResult{Name: n.Name, SDKAccepted: err == nil}
		if err != nil {
			// 报错原文里带着整个请求，这里只留前 80 个字符
			message := err.Error()
			if len(message) > 80 {
				message = message[:80]
			}
			result.SDKError = message
		} else {
			result.ID = parsed.ID
			result.EventType = parsed.EventType
			result.SDKPlaintext = parsed.Resource.Plaintext
		}
		out.Notifications = append(out.Notifications, result)
	}

	wechatPayPrivateKey, err := utils.LoadPrivateKey(in.WechatPay.PrivateKeyPem)
	must(err)
	platform := &signers.SHA256WithRSASigner{MchID: "0", CertificateSerialNo: in.WechatPay.Serial, PrivateKey: wechatPayPrivateKey}
	for _, d := range in.ToSign {
		message := d.Headers["Wechatpay-Timestamp"] + "\n" + d.Headers["Wechatpay-Nonce"] + "\n" + d.Body + "\n"
		signed, err := platform.Sign(ctx, message)
		must(err)
		headers := map[string]string{}
		for name, value := range d.Headers {
			headers[name] = value
		}
		headers["Wechatpay-Signature"] = signed.Signature
		headers["Wechatpay-Serial"] = in.WechatPay.Serial
		out.Signed = append(out.Signed, Delivery{Name: d.Name, Headers: headers, Body: d.Body})
	}

	encoded, err := json.MarshalIndent(out, "", "  ")
	must(err)
	must(os.WriteFile(os.Args[2], encoded, 0o600))
}
