import React, { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

type RowProps = { id: string; title: string };

function withTheme<T extends object>(Component: React.ComponentType<T>): React.FC<T> {
  return function ThemedComponent(props: T) {
    return <Component {...props} />;
  };
}

const ThemedRow = withTheme<RowProps>(({ id, title }) => (
  <Pressable testID={`row-${id}`}>
    <Text>{title}</Text>
  </Pressable>
));

/** Small RN 0.81 fixture for device-level Inspector validation. */
export default function InspectorFixture(): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const rows = [{ id: '101', title: 'First' }, { id: '102', title: 'Second' }];
  return (
    <View>
      <Pressable onPress={() => setLoading((value) => !value)}>
        <Text>{loading ? 'Loading' : 'Ready'}</Text>
      </Pressable>
      {loading ? <Text>Loading branch</Text> : <Text>Content branch</Text>}
      <FlatList data={rows} keyExtractor={(item) => item.id} renderItem={({ item }) => (
        <ThemedRow id={item.id} title={item.title} />
      )} />
    </View>
  );
}
