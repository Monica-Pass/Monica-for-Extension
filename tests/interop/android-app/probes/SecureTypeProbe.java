import java.lang.reflect.Method;

/** Read-only JVM probe of the already-built, unmodified Android resolver class. */
class SecureTypeProbe {
    public static void main(String[] args) throws Exception {
        Class<?> resolver = Class.forName("takagi.ru.monica.utils.SecureItemRestoreTypeResolver");
        Object instance = resolver.getField("INSTANCE").get(null);
        Method resolve = resolver.getMethod("resolve", String.class, String.class, String.class);
        String[][] cases = {
            {"TOTP", "{\"secret\":\"synthetic\"}"},
            {"BANK_CARD", "{\"cardNumber\":\"0007\"}"},
            {"DOCUMENT", "{\"documentNumber\":\"0007\"}"},
            {"NOTE", "{\"content\":\"synthetic\"}"},
            {"BILLING_ADDRESS", "{\"company\":\"Synthetic\",\"postalCode\":\"00001\",\"country\":\"CN\"}"},
            {"PAYMENT_ACCOUNT", "{\"paymentType\":\"BANK_ACCOUNT\",\"routingNumber\":\"0001\",\"iban\":\"GB00SYNTHETIC\"}"}
        };
        int failures = 0;
        for (String[] item : cases) {
            Object actual = resolve.invoke(instance, item[0], item[1], "item_315.json");
            boolean passed = item[0].equals(String.valueOf(actual));
            System.out.println(item[0] + " -> " + actual + " " + (passed ? "PASS" : "FAIL"));
            if (!passed) failures++;
        }
        System.out.println("declared-type mismatches=" + failures + "/" + cases.length);
        if (failures != 0) System.exit(2);
    }
}
